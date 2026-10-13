import {
    MAX_REPORT_BATCH_BYTES,
    MAX_REPORT_BATCH_SIZE,
    REPORT_COALESCE_IDLE_MS,
    REPORT_HOT_PATH_RETRIES,
    REPORT_MAX_IN_FLIGHT,
} from './constants.js';

function serializedBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

/**
 * Coalesce settled check results into micro-batches before report HTTP.
 * Flushes on count, bytes, idle timeout, or explicit flush (poll end).
 * Limits concurrent reportBatch requests via a small semaphore.
 */
export class ReportCoalescer {
    constructor(resultQueue, options = {}) {
        this.resultQueue = resultQueue;
        this.maxCount = Math.max(1, options.maxCount || MAX_REPORT_BATCH_SIZE);
        this.maxBytes = Math.max(1024, options.maxBytes || MAX_REPORT_BATCH_BYTES);
        this.idleMs = Math.max(1, options.idleMs || REPORT_COALESCE_IDLE_MS);
        this.maxInFlight = Math.max(1, options.maxInFlight || REPORT_MAX_IN_FLIGHT);
        this.hotPathRetries = Number.isInteger(options.hotPathRetries)
            ? options.hotPathRetries
            : REPORT_HOT_PATH_RETRIES;
        this.buffer = [];
        this.bufferBytes = 0;
        this.idleTimer = null;
        this.inFlight = 0;
        this.waiters = [];
        this.pending = [];
        this.settleCallbacks = [];
        this.closed = false;
        this.defaultSignal = null;
    }

    /**
     * Buffer a result. options.onSettled runs once its report request has
     * finished, delivered or handed to the retry queue, so a caller can hold
     * a check until the console has seen it.
     */
    push(result, options = {}) {
        const onSettled = typeof options.onSettled === 'function' ? options.onSettled : null;
        if (this.closed || result == null) {
            onSettled?.();
            return;
        }
        if (options.signal) this.defaultSignal = options.signal;

        const bytes = serializedBytes(result);
        if (!Number.isFinite(bytes)) {
            onSettled?.();
            return;
        }

        this.buffer.push(result);
        this.bufferBytes += bytes;
        if (onSettled) this.settleCallbacks.push(onSettled);
        this.armIdleTimer();

        if (this.buffer.length >= this.maxCount || this.bufferBytes >= this.maxBytes) {
            this.scheduleFlush(options);
        }
    }

    /**
     * Max-wait, not debounce: the first buffered result starts the timer and
     * later ones do not push it back. Checks that settle steadily (scheduled
     * runs spread over the interval) then share one request per window
     * instead of each sending its own.
     */
    armIdleTimer() {
        if (this.idleTimer) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            this.scheduleFlush({ signal: this.defaultSignal });
        }, this.idleMs);
        this.idleTimer.unref?.();
    }

    clearIdleTimer() {
        if (!this.idleTimer) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    scheduleFlush(options = {}) {
        if (this.buffer.length === 0) return;
        const batch = this.buffer;
        const batchBytes = this.bufferBytes;
        const callbacks = this.settleCallbacks;
        this.buffer = [];
        this.bufferBytes = 0;
        this.settleCallbacks = [];
        this.clearIdleTimer();

        const work = this.runFlush(batch, batchBytes, options)
            .catch(() => false)
            .finally(() => {
                for (const callback of callbacks) {
                    try { callback(); } catch { /* never break the flush */ }
                }
            });
        this.pending.push(work);
        void work.finally(() => {
            const index = this.pending.indexOf(work);
            if (index >= 0) this.pending.splice(index, 1);
        });
    }

    async acquireSlot() {
        if (this.inFlight < this.maxInFlight) {
            this.inFlight++;
            return;
        }
        await new Promise((resolve) => this.waiters.push(resolve));
        this.inFlight++;
    }

    releaseSlot() {
        this.inFlight = Math.max(0, this.inFlight - 1);
        const next = this.waiters.shift();
        if (next) next();
    }

    async runFlush(batch, _batchBytes, options = {}) {
        if (batch.length === 0) return true;
        await this.acquireSlot();
        try {
            return await this.resultQueue.submitBatch(batch, {
                signal: options.signal || this.defaultSignal,
                retries: this.hotPathRetries,
            });
        } finally {
            this.releaseSlot();
        }
    }

    async flush(options = {}) {
        this.scheduleFlush(options);
        if (this.pending.length === 0) return true;
        const outcomes = await Promise.all(this.pending.slice());
        return outcomes.every((ok) => ok !== false);
    }

    get size() {
        return this.buffer.length;
    }

    get bytes() {
        return this.bufferBytes;
    }

    get telemetry() {
        return {
            buffered: this.size,
            buffered_bytes: this.bytes,
            in_flight: this.inFlight,
            pending_flushes: this.pending.length,
            max_in_flight: this.maxInFlight,
        };
    }

    stop() {
        this.closed = true;
        this.clearIdleTimer();
    }

    /** Close and settle anything still buffered (nothing will send it now). */
    close() {
        this.stop();
        const callbacks = this.settleCallbacks;
        this.settleCallbacks = [];
        for (const callback of callbacks) {
            try { callback(); } catch { /* ignore */ }
        }
    }
}
