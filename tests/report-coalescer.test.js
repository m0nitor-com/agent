import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportCoalescer } from '../src/lib/report-coalescer.js';

describe('ReportCoalescer', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('flushes when the count threshold is reached', async () => {
        const submitBatch = vi.fn().mockResolvedValue(true);
        const coalescer = new ReportCoalescer({ submitBatch }, {
            maxCount: 3,
            maxBytes: 1024 * 1024,
            idleMs: 1000,
            maxInFlight: 2,
            hotPathRetries: 0,
        });

        coalescer.push({ monitor_id: 1 });
        coalescer.push({ monitor_id: 2 });
        expect(submitBatch).not.toHaveBeenCalled();
        coalescer.push({ monitor_id: 3 });

        await vi.waitFor(() => expect(submitBatch).toHaveBeenCalledTimes(1));
        expect(submitBatch.mock.calls[0][0]).toHaveLength(3);
        expect(submitBatch.mock.calls[0][1]).toMatchObject({ retries: 0 });
        coalescer.stop();
    });

    it('flushes after idle timeout', async () => {
        vi.useFakeTimers();
        const submitBatch = vi.fn().mockResolvedValue(true);
        const coalescer = new ReportCoalescer({ submitBatch }, {
            maxCount: 100,
            maxBytes: 1024 * 1024,
            idleMs: 30,
            maxInFlight: 1,
        });

        coalescer.push({ monitor_id: 9 });
        expect(submitBatch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30);
        await Promise.resolve();
        expect(submitBatch).toHaveBeenCalledTimes(1);
        coalescer.stop();
    });

    it('limits concurrent report submissions', async () => {
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        const submitBatch = vi.fn()
            .mockImplementationOnce(() => firstGate.then(() => true))
            .mockResolvedValue(true);

        const coalescer = new ReportCoalescer({ submitBatch }, {
            maxCount: 1,
            maxBytes: 1024 * 1024,
            idleMs: 1000,
            maxInFlight: 1,
        });

        coalescer.push({ monitor_id: 1 });
        coalescer.push({ monitor_id: 2 });
        await vi.waitFor(() => expect(submitBatch).toHaveBeenCalledTimes(1));

        releaseFirst();
        await coalescer.flush();
        expect(submitBatch).toHaveBeenCalledTimes(2);
        coalescer.stop();
    });
});
