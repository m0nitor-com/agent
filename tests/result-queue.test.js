import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResultQueue } from '../src/lib/result-queue.js';

describe('ResultQueue', () => {
    let mockApi;
    let queue;

    beforeEach(() => {
        mockApi = {
            reportCheck: vi.fn(),
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

    it('limits queue size and drops oldest', () => {
        // Fill queue manually beyond max
        for (let i = 0; i < 1001; i++) {
            queue.enqueue({ monitor_id: i, is_success: true });
        }
        expect(queue.size).toBe(1000);
    });

    it('processes queue and removes successful items', async () => {
        // Enqueue manually
        queue.queue.push({ result: fakeResult, retries: 0 });
        mockApi.reportCheck.mockResolvedValue({});

        await queue.processQueue();
        expect(queue.size).toBe(0);
    });

    it('keeps failed items in queue with incremented retries', async () => {
        queue.queue.push({ result: fakeResult, retries: 0 });
        mockApi.reportCheck.mockRejectedValue(new Error('Still failing'));

        await queue.processQueue();
        expect(queue.size).toBe(1);
        expect(queue.queue[0].retries).toBe(1);
    });

    it('discards items after max retries', async () => {
        queue.queue.push({ result: fakeResult, retries: 4 }); // one more retry = 5 = max
        mockApi.reportCheck.mockRejectedValue(new Error('Still failing'));

        await queue.processQueue();
        expect(queue.size).toBe(0);
    });

    it('stops retry timer on stop()', () => {
        queue.enqueue(fakeResult);
        expect(queue.retryTimer).not.toBeNull();
        queue.stop();
        expect(queue.retryTimer).toBeNull();
    });
});
