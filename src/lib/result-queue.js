import { logger } from './logger.js';
import { RESULT_QUEUE_MAX_SIZE, RESULT_QUEUE_RETRY_INTERVAL_MS, RESULT_QUEUE_MAX_RETRIES } from './constants.js';

/**
 * In-memory result queue that buffers failed report submissions
 * and retries them automatically.
 */
export class ResultQueue {
    constructor(apiClient) {
        this.api = apiClient;
        this.queue = [];
        this.retryTimer = null;
        this.isProcessing = false;
    }

    /**
     * Submit a check result. If reporting fails, enqueue for retry.
     * @returns {boolean} true if reported immediately, false if queued
     */
    async submit(result) {
        try {
            await this.api.reportCheck(result);
            return true;
        } catch (error) {
            logger.warn({ monitor_id: result.monitor_id, err: error },
                '[QUEUE] Failed to report result, enqueueing for retry');
            this.enqueue(result);
            return false;
        }
    }

    /**
     * Add a result to the retry queue.
     */
    enqueue(result) {
        if (this.queue.length >= RESULT_QUEUE_MAX_SIZE) {
            // Drop oldest entry to make room
            const dropped = this.queue.shift();
            logger.warn({ monitor_id: dropped.result.monitor_id },
                '[QUEUE] Queue full, dropping oldest result');
        }

        this.queue.push({ result, retries: 0 });
        this.scheduleRetry();
    }

    /**
     * Schedule the retry processor if not already scheduled.
     */
    scheduleRetry() {
        if (this.retryTimer) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.processQueue();
        }, RESULT_QUEUE_RETRY_INTERVAL_MS);
    }

    /**
     * Process all queued results, removing successful ones.
     */
    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        logger.info(`[QUEUE] Retrying ${this.queue.length} queued result(s)...`);

        const remaining = [];

        for (const entry of this.queue) {
            try {
                await this.api.reportCheck(entry.result);
                logger.debug({ monitor_id: entry.result.monitor_id }, '[QUEUE] Retry succeeded');
            } catch (error) {
                entry.retries++;
                if (entry.retries >= RESULT_QUEUE_MAX_RETRIES) {
                    logger.error({ monitor_id: entry.result.monitor_id, retries: entry.retries },
                        '[QUEUE] Max retries exceeded, discarding result');
                } else {
                    remaining.push(entry);
                }
            }
        }

        this.queue = remaining;
        this.isProcessing = false;

        if (this.queue.length > 0) {
            this.scheduleRetry();
        }
    }

    /**
     * Get current queue size (for health endpoint).
     */
    get size() {
        return this.queue.length;
    }

    /**
     * Stop the retry timer (for graceful shutdown).
     */
    stop() {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }
}
