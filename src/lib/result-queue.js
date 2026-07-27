import { logger } from './logger.js';
import {
    MAX_REPORT_BATCH_BYTES,
    MAX_REPORT_BATCH_SIZE,
    RESULT_QUEUE_MAX_BYTES,
    RESULT_QUEUE_MAX_RETRIES,
    RESULT_QUEUE_MAX_SIZE,
    RESULT_QUEUE_RETRY_INTERVAL_MS,
    RESULT_QUEUE_RETRY_MAX_INTERVAL_MS,
} from './constants.js';

function serializedBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function safeErrorFields(error) {
    return {
        code: typeof error?.code === 'string' ? error.code.slice(0, 40) : undefined,
        status: Number.isInteger(error?.response?.status) ? error.response.status : undefined,
    };
}

function isAbortError(error, signal) {
    if (signal?.aborted) return true;
    if (!error) return false;
    if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') return true;
    return /abort|cancel/i.test(String(error.message || ''));
}

export class ResultQueue {
    constructor(apiClient, options = {}) {
        this.api = apiClient;
        this.queue = [];
        this.queuedBytes = 0;
        this.retryTimer = null;
        this.isProcessing = false;
        this.processingPromise = null;
        this.activePassController = null;
        this.maxEntries = options.maxEntries || RESULT_QUEUE_MAX_SIZE;
        this.maxBytes = options.maxBytes || RESULT_QUEUE_MAX_BYTES;
        this.maxBatchSize = options.maxBatchSize || MAX_REPORT_BATCH_SIZE;
        this.maxBatchBytes = options.maxBatchBytes || MAX_REPORT_BATCH_BYTES;
        this.retryIntervalMs = options.retryIntervalMs || RESULT_QUEUE_RETRY_INTERVAL_MS;
        this.retryMaxIntervalMs = options.retryMaxIntervalMs || RESULT_QUEUE_RETRY_MAX_INTERVAL_MS;
        this.random = options.random || Math.random;
        this.retryAttempt = 0;
        this.nextRetryAt = null;
        this.counters = {
            enqueued: 0,
            delivered: 0,
            retried: 0,
            dropped_oldest: 0,
            dropped_oversize: 0,
            discarded_after_retries: 0,
            report_failures: 0,
            report_batches: 0,
        };
        this.lastSuccessfulReportAt = null;
        this.lastReportFailureAt = null;
    }

    async submit(result, options = {}) {
        try {
            if (Object.keys(options).length > 0) {
                await this.api.reportCheck(result, options);
            } else {
                await this.api.reportCheck(result);
            }
            this.markDelivered(1);
            return true;
        } catch (error) {
            this.markFailure();
            logger.warn({ monitor_id: result.monitor_id, ...safeErrorFields(error) },
                '[QUEUE] Failed to report result, enqueueing for retry');
            this.enqueue(result);
            return false;
        }
    }

    async submitBatch(results, options = {}) {
        if (!Array.isArray(results) || results.length === 0) return true;

        let allReported = true;
        for (const chunk of this.toBoundedChunks(results)) {
            try {
                if (Object.keys(options).length > 0) {
                    await this.api.reportBatch(chunk, options);
                } else {
                    await this.api.reportBatch(chunk);
                }
                this.counters.report_batches++;
                this.markDelivered(chunk.length);
            } catch (error) {
                this.markFailure();
                logger.warn({ count: chunk.length, ...safeErrorFields(error) },
                    '[QUEUE] Batch report failed, enqueueing results for retry');
                for (const result of chunk) this.enqueue(result);
                allReported = false;
            }
        }
        return allReported;
    }

    toBoundedChunks(results) {
        const chunks = [];
        let chunk = [];
        let chunkBytes = serializedBytes({ reports: [] });

        for (const result of results) {
            const bytes = serializedBytes(result) + 1;
            if (bytes > this.maxBatchBytes) {
                this.counters.dropped_oversize++;
                logger.warn({ monitor_id: result?.monitor_id, bytes },
                    '[QUEUE] Dropping result that exceeds report byte ceiling');
                continue;
            }
            if (chunk.length >= this.maxBatchSize || chunkBytes + bytes > this.maxBatchBytes) {
                if (chunk.length > 0) chunks.push(chunk);
                chunk = [];
                chunkBytes = serializedBytes({ reports: [] });
            }
            chunk.push(result);
            chunkBytes += bytes;
        }
        if (chunk.length > 0) chunks.push(chunk);
        return chunks;
    }

    enqueue(result) {
        const bytes = serializedBytes(result);
        if (!Number.isFinite(bytes) || bytes > this.maxBytes) {
            this.counters.dropped_oversize++;
            logger.warn({ monitor_id: result?.monitor_id },
                '[QUEUE] Dropping result that exceeds retry storage byte ceiling');
            return false;
        }

        while (this.queue.length >= this.maxEntries || this.queuedBytes + bytes > this.maxBytes) {
            const dropped = this.queue.shift();
            if (!dropped) break;
            this.queuedBytes -= dropped.bytes;
            this.counters.dropped_oldest++;
            logger.warn({ monitor_id: dropped.result.monitor_id },
                '[QUEUE] Retry storage full, dropping oldest result');
        }

        this.queue.push({ result, retries: 0, bytes });
        this.queuedBytes += bytes;
        this.counters.enqueued++;
        this.scheduleRetry();
        return true;
    }

    scheduleRetry() {
        if (this.retryTimer || this.queue.length === 0) return;
        const ceiling = Math.min(
            this.retryMaxIntervalMs,
            this.retryIntervalMs * (2 ** Math.min(this.retryAttempt, 8)),
        );
        const delay = Math.max(1, Math.round(ceiling * (0.5 + this.random() * 0.5)));
        this.nextRetryAt = new Date(Date.now() + delay);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.nextRetryAt = null;
            void this.processQueue();
        }, delay);
        this.retryTimer.unref?.();
    }

    async processQueue(options = {}) {
        if (this.processingPromise) return this.processingPromise;
        if (this.queue.length === 0) return;

        this.processingPromise = this.runQueuePass(options)
            .finally(() => {
                this.isProcessing = false;
                this.processingPromise = null;
                if (this.activePassController) {
                    this.activePassController = null;
                }
                if (this.queue.length > 0) {
                    this.retryAttempt++;
                    this.scheduleRetry();
                } else {
                    this.retryAttempt = 0;
                }
            });
        this.isProcessing = true;
        return this.processingPromise;
    }

    async runQueuePass(options = {}) {
        const passController = new AbortController();
        this.activePassController = passController;

        const forwardAbort = () => {
            if (!passController.signal.aborted) {
                passController.abort(options.signal?.reason || new Error('Queue pass aborted'));
            }
        };
        if (options.signal) {
            if (options.signal.aborted) forwardAbort();
            else options.signal.addEventListener('abort', forwardAbort, { once: true });
        }

        const signal = passController.signal;
        const requestOptions = { ...options, signal };
        const pending = this.queue;
        this.queue = [];
        this.queuedBytes = 0;
        logger.info({ count: pending.length }, '[QUEUE] Retrying queued results');

        const unsettled = new Set(pending);
        const byRetry = new Map();
        for (const entry of pending) {
            const group = byRetry.get(entry.retries) || [];
            group.push(entry);
            byRetry.set(entry.retries, group);
        }

        try {
            for (const entries of byRetry.values()) {
                const results = entries.map((entry) => entry.result);
                for (const chunk of this.toBoundedChunks(results)) {
                    if (signal.aborted) {
                        throw signal.reason || new Error('Queue pass aborted');
                    }
                    try {
                        await this.api.reportBatch(chunk, requestOptions);
                        this.counters.report_batches++;
                        this.counters.retried += chunk.length;
                        this.markDelivered(chunk.length);
                        const delivered = new Set(chunk);
                        for (const entry of entries) {
                            if (delivered.has(entry.result)) unsettled.delete(entry);
                        }
                    } catch (error) {
                        if (isAbortError(error, signal)) {
                            throw error;
                        }
                        this.markFailure();
                        const chunkResults = new Set(chunk);
                        for (const entry of entries) {
                            if (!chunkResults.has(entry.result)) continue;
                            unsettled.delete(entry);
                            entry.retries++;
                            if (entry.retries >= RESULT_QUEUE_MAX_RETRIES) {
                                this.counters.discarded_after_retries++;
                                logger.error({
                                    monitor_id: entry.result.monitor_id,
                                    retries: entry.retries,
                                    ...safeErrorFields(error),
                                }, '[QUEUE] Retry limit reached, discarding result');
                            } else {
                                this.restoreEntry(entry);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            if (!isAbortError(error, signal)) {
                logger.warn({ ...safeErrorFields(error) }, '[QUEUE] Queue pass failed');
            }
        } finally {
            for (const entry of unsettled) {
                this.restoreEntry(entry);
            }
            if (options.signal) {
                options.signal.removeEventListener('abort', forwardAbort);
            }
            if (this.activePassController === passController) {
                this.activePassController = null;
            }
        }
    }

    restoreEntry(entry) {
        while (this.queue.length >= this.maxEntries || this.queuedBytes + entry.bytes > this.maxBytes) {
            const dropped = this.queue.shift();
            if (!dropped) return;
            this.queuedBytes -= dropped.bytes;
            this.counters.dropped_oldest++;
        }
        this.queue.push(entry);
        this.queuedBytes += entry.bytes;
    }

    /**
     * Drop the oldest queued results (governor hard-pressure path).
     */
    dropOldest(count = 1) {
        const target = Math.max(1, count);
        let dropped = 0;
        while (dropped < target && this.queue.length > 0) {
            const entry = this.queue.shift();
            if (!entry) break;
            this.queuedBytes -= entry.bytes;
            this.counters.dropped_oldest++;
            dropped++;
        }
        return dropped;
    }

    markDelivered(count) {
        this.counters.delivered += count;
        this.lastSuccessfulReportAt = new Date();
    }

    markFailure() {
        this.counters.report_failures++;
        this.lastReportFailureAt = new Date();
    }

    abortActivePass(reason) {
        if (!this.activePassController || this.activePassController.signal.aborted) return;
        this.activePassController.abort(reason || new Error('Queue pass aborted'));
    }

    async flush(timeoutMs) {
        this.stop();
        if (this.queue.length === 0 && !this.processingPromise) return true;

        const controller = new AbortController();
        const deadlineError = new Error('Result flush deadline exceeded');
        const timer = setTimeout(() => {
            controller.abort(deadlineError);
            this.abortActivePass(deadlineError);
        }, timeoutMs);
        timer.unref?.();

        this.abortActivePass(new Error('Result flush superseded'));

        const waitForDeadline = () => new Promise((_, reject) => {
            const fail = () => reject(controller.signal.reason || deadlineError);
            if (controller.signal.aborted) {
                fail();
                return;
            }
            controller.signal.addEventListener('abort', fail, { once: true });
        });

        try {
            if (this.processingPromise) {
                await Promise.race([
                    this.processingPromise.then(() => undefined, () => undefined),
                    waitForDeadline(),
                ]);
            }
            if (controller.signal.aborted) return false;
            if (this.queue.length > 0) {
                await Promise.race([
                    this.processQueue({ signal: controller.signal, retries: 0 }),
                    waitForDeadline(),
                ]);
            }
            return this.queue.length === 0;
        } catch {
            this.abortActivePass(controller.signal.reason || deadlineError);
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    get size() {
        return this.queue.length;
    }

    get bytes() {
        return this.queuedBytes;
    }

    get telemetry() {
        return {
            size: this.size,
            bytes: this.bytes,
            processing: this.isProcessing,
            counters: { ...this.counters },
            last_successful_report: this.lastSuccessfulReportAt?.toISOString() || null,
            last_report_failure: this.lastReportFailureAt?.toISOString() || null,
            retry_attempt: this.retryAttempt,
            next_retry_at: this.nextRetryAt?.toISOString() || null,
        };
    }

    stop() {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
            this.nextRetryAt = null;
        }
    }
}
