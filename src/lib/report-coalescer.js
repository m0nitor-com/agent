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
        this.closed = false;
        this.defaultSignal = null;
    }

    push(result, options = {}) {
        if (this.closed || result == null) return;
        if (options.signal) this.defaultSignal = options.signal;

        const bytes = serializedBytes(result);
        if (!Number.isFinite(bytes)) return;

        this.buffer.push(result);
        this.bufferBytes += bytes;
        this.armIdleTimer();

        if (this.buffer.length >= this.maxCount || this.bufferBytes >= this.maxBytes) {
            this.scheduleFlush(options);
        }
    }

    armIdleTimer() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
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
        this.buffer = [];
        this.bufferBytes = 0;
        this.clearIdleTimer();

        const work = this.runFlush(batch, batchBytes, options);
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
}
