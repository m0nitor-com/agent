import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResultQueue } from '../src/lib/result-queue.js';

describe('ResultQueue', () => {
    let mockApi;
    let queue;

    beforeEach(() => {
        mockApi = {
            reportCheck: vi.fn(),
            reportBatch: vi.fn(),
        };
        queue = new ResultQueue(mockApi);
    });

    afterEach(() => {
        queue.stop();
    });

    const fakeResult = { monitor_id: 1, is_success: true, response_time_ms: 100 };

    it('submits result directly when API succeeds', async () => {
        mockApi.reportCheck.mockResolvedValue({});
        const submitted = await queue.submit(fakeResult);
        expect(submitted).toBe(true);
        expect(mockApi.reportCheck).toHaveBeenCalledWith(fakeResult);
        expect(queue.size).toBe(0);
    });

    it('enqueues result when API fails', async () => {
        mockApi.reportCheck.mockRejectedValue(new Error('Network error'));
        const submitted = await queue.submit(fakeResult);
        expect(submitted).toBe(false);
        expect(queue.size).toBe(1);
    });

    it('submits a whole chunk in a single request when the API succeeds', async () => {
        mockApi.reportBatch.mockResolvedValue({});
        const r2 = { monitor_id: 2, is_success: false };
        const submitted = await queue.submitBatch([fakeResult, r2]);
        expect(submitted).toBe(true);
        expect(mockApi.reportBatch).toHaveBeenCalledTimes(1);
        expect(mockApi.reportBatch).toHaveBeenCalledWith([fakeResult, r2]);
        expect(mockApi.reportCheck).not.toHaveBeenCalled();
        expect(queue.size).toBe(0);
    });

    it('enqueues each result for retry when the batch fails', async () => {
        mockApi.reportBatch.mockRejectedValue(new Error('Network error'));
        const submitted = await queue.submitBatch([fakeResult, { monitor_id: 2, is_success: true }]);
        expect(submitted).toBe(false);
        expect(queue.size).toBe(2);
    });

    it('returns true for an empty batch without calling the API', async () => {
        const submitted = await queue.submitBatch([]);
        expect(submitted).toBe(true);
        expect(mockApi.reportBatch).not.toHaveBeenCalled();
    });

    it('limits queue size and drops oldest', () => {
        // Fill queue manually beyond max (SKU default is 500)
        for (let i = 0; i < 501; i++) {
            queue.enqueue({ monitor_id: i, is_success: true });
        }
        expect(queue.size).toBe(500);
    });

    it('dropOldest removes the oldest buffered results', () => {
        queue.enqueue({ monitor_id: 1, is_success: true });
        queue.enqueue({ monitor_id: 2, is_success: true });
        expect(queue.dropOldest(1)).toBe(1);
        expect(queue.size).toBe(1);
        expect(queue.queue[0].result.monitor_id).toBe(2);
    });

    it('limits serialized retry bytes and records the drop policy', () => {
        queue = new ResultQueue(mockApi, { maxEntries: 10, maxBytes: 180 });
        queue.enqueue({ monitor_id: 1, is_success: false, error_message: 'x'.repeat(50) });
        queue.enqueue({ monitor_id: 2, is_success: false, error_message: 'y'.repeat(50) });

        expect(queue.size).toBeLessThanOrEqual(1);
        expect(queue.bytes).toBeLessThanOrEqual(180);
        expect(queue.telemetry.counters.dropped_oldest).toBeGreaterThanOrEqual(1);
    });

    it('processes queue and removes successful items', async () => {
        queue.enqueue(fakeResult);
        mockApi.reportBatch.mockResolvedValue({});

        await queue.processQueue();
        expect(queue.size).toBe(0);
        expect(mockApi.reportBatch).toHaveBeenCalledWith(
            [fakeResult],
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });

    it('keeps failed items in queue with incremented retries', async () => {
        queue.enqueue(fakeResult);
        mockApi.reportBatch.mockRejectedValue(new Error('Still failing'));

        await queue.processQueue();
        expect(queue.size).toBe(1);
        expect(queue.queue[0].retries).toBe(1);
    });

    it('discards items after max retries', async () => {
        queue.enqueue(fakeResult);
        queue.queue[0].retries = 4; // one more retry = 5 = max
        mockApi.reportBatch.mockRejectedValue(new Error('Still failing'));

        await queue.processQueue();
        expect(queue.size).toBe(0);
    });

    it('stops retry timer on stop()', () => {
        queue.enqueue(fakeResult);
        expect(queue.retryTimer).not.toBeNull();
        queue.stop();
        expect(queue.retryTimer).toBeNull();
    });

    it('aborts in-flight retry processing when flush deadline is exceeded', async () => {
        let reportSignal = null;
        mockApi.reportBatch.mockImplementation((_chunk, options = {}) => new Promise((_, reject) => {
            reportSignal = options.signal;
            const fail = () => reject(options.signal?.reason || new Error('aborted'));
            if (options.signal?.aborted) {
                fail();
                return;
            }
            options.signal?.addEventListener('abort', fail, { once: true });
        }));

        queue.enqueue(fakeResult);
        const processing = queue.processQueue();
        await vi.waitFor(() => {
            expect(mockApi.reportBatch).toHaveBeenCalled();
            expect(reportSignal).not.toBeNull();
        });

        const started = Date.now();
        const flushed = await queue.flush(40);
        const elapsed = Date.now() - started;

        expect(flushed).toBe(false);
        expect(elapsed).toBeLessThan(250);
        expect(reportSignal.aborted).toBe(true);
        await processing;
        expect(queue.size).toBe(1);
    });
});
