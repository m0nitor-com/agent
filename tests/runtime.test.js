import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { CheckRegistry } from '../src/lib/check-registry.js';

function baseConfig(overrides = {}) {
    return {
        POLL_INTERVAL: 1000,
        POLL_MAX_INTERVAL: 5000,
        CONCURRENCY_LIMIT: 2,
        NETWORK_CONCURRENCY: 2,
        DATABASE_CONCURRENCY: 1,
        DIAGNOSTIC_CONCURRENCY: 1,
        RESULT_QUEUE_MAX_BYTES: 1024,
        RESULT_QUEUE_MAX_ENTRIES: 100,
        REPORT_BATCH_MAX_BYTES: 1024,
        REPORT_BATCH_MAX_SIZE: 1,
        REPORT_COALESCE_IDLE_MS: 5,
        REPORT_MAX_IN_FLIGHT: 2,
        SOFT_RSS_BYTES: 350 * 1024 * 1024,
        HARD_RSS_BYTES: 550 * 1024 * 1024,
        HTTP_MAX_SOCKETS: 6,
        HTTP_MAX_FREE_SOCKETS: 2,
        SHUTDOWN_FLUSH_TIMEOUT: 50,
        HEALTH_PORT: 0,
        EGRESS_DETECT: false,
        ...overrides,
    };
}

function createRuntime(apiOverrides = {}, configOverrides = {}) {
    const registry = new CheckRegistry().register('fake', {
        capability: 'fake',
        budget: 'network',
        validate: (raw) => raw,
        handler: async (monitor) => ({
            monitor_id: monitor.id,
            is_success: true,
            response_time_ms: 1,
        }),
    });
    const api = {
        getChecks: vi.fn().mockResolvedValue({ monitors: [] }),
        close: vi.fn(),
        ...apiOverrides,
    };
    const resultQueue = {
        submitBatch: vi.fn().mockResolvedValue(true),
        flush: vi.fn().mockResolvedValue(true),
        dropOldest: vi.fn().mockReturnValue(0),
        size: 0,
        telemetry: { size: 0, bytes: 0, counters: {} },
    };
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };
    return {
        runtime: new AgentRuntime({
            config: baseConfig(configOverrides),
            logger,
            registry,
            api,
            resultQueue,
            version: 'test',
        }),
        api,
        resultQueue,
        logger,
    };
}

describe('AgentRuntime', () => {
    it('does not overlap poll cycles', async () => {
        let release;
        const waiting = new Promise((resolve) => { release = resolve; });
        const { runtime } = createRuntime({
            getChecks: vi.fn().mockReturnValue(waiting),
        });

        const first = runtime.pollOnce();
        const second = await runtime.pollOnce();
        expect(second).toBeNull();
        expect(runtime.state.pollOverlapSkips).toBe(1);

        release({ monitors: [] });
        await first;
        await runtime.shutdown('test');
    });

    it('micro-batches settled results and can flush the first result before the poll ends', async () => {
        const submitOrder = [];
        let releaseSecond;
        const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
        const registry = new CheckRegistry()
            .register('fast', {
                capability: 'fast',
                budget: 'network',
                validate: (raw) => raw,
                handler: async (monitor) => ({
                    monitor_id: monitor.id,
                    is_success: true,
                    response_time_ms: 1,
                }),
            })
            .register('slow', {
                capability: 'slow',
                budget: 'network',
                validate: (raw) => raw,
                handler: async (monitor) => {
                    await secondGate;
                    return {
                        monitor_id: monitor.id,
                        is_success: true,
                        response_time_ms: 2,
                    };
                },
            });
        const api = {
            getChecks: vi.fn().mockResolvedValue({
                monitors: [
                    { id: 1, type: 'fast', timeout: 1 },
                    { id: 2, type: 'slow', timeout: 1 },
                ],
            }),
            close: vi.fn(),
        };
        const resultQueue = {
            submitBatch: vi.fn(async (batch) => {
                submitOrder.push(batch.map((item) => item.monitor_id));
                return true;
            }),
            flush: vi.fn().mockResolvedValue(true),
            dropOldest: vi.fn().mockReturnValue(0),
            size: 0,
            telemetry: { size: 0, bytes: 0, counters: {} },
        };
        const logger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };
        const runtime = new AgentRuntime({
            config: baseConfig({ REPORT_BATCH_MAX_SIZE: 1 }),
            logger,
            registry,
            api,
            resultQueue,
            version: 'test',
        });

        const poll = runtime.pollOnce();
        await vi.waitFor(() => {
            expect(resultQueue.submitBatch).toHaveBeenCalledTimes(1);
        });
        expect(submitOrder).toEqual([[1]]);

        releaseSecond();
        await poll;

        expect(resultQueue.submitBatch).toHaveBeenCalledTimes(2);
        expect(submitOrder).toEqual([[1], [2]]);
        expect(runtime.state.totalChecks).toBe(2);
        await runtime.shutdown('test');
    });

    it('coalesces multiple results into one report batch when under the count ceiling', async () => {
        const { runtime, resultQueue } = createRuntime({
            getChecks: vi.fn().mockResolvedValue({
                monitors: [
                    { id: 1, type: 'fake', timeout: 1 },
                    { id: 2, type: 'fake', timeout: 1 },
                ],
            }),
        }, {
            REPORT_BATCH_MAX_SIZE: 10,
            REPORT_COALESCE_IDLE_MS: 5000,
        });

        await runtime.pollOnce();
        expect(resultQueue.submitBatch).toHaveBeenCalledTimes(1);
        expect(resultQueue.submitBatch.mock.calls[0][0]).toHaveLength(2);
        expect(resultQueue.submitBatch.mock.calls[0][1]).toMatchObject({ retries: 0 });
        await runtime.shutdown('test');
    });

    it('executes registered checks and submits settled results', async () => {
        const { runtime, resultQueue } = createRuntime({
            getChecks: vi.fn().mockResolvedValue({
                monitors: [{ id: 7, type: 'fake', timeout: 1 }],
            }),
        });

        await runtime.pollOnce();
        expect(resultQueue.submitBatch).toHaveBeenCalledWith(
            [expect.objectContaining({ monitor_id: 7, is_success: true })],
            expect.objectContaining({ signal: expect.any(AbortSignal), retries: 0 }),
        );
        expect(runtime.state.totalChecks).toBe(1);
        await runtime.shutdown('test');
    });
});
