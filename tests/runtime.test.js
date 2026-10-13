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
        await runtime.idle();

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
        await runtime.idle();
        expect(resultQueue.submitBatch).toHaveBeenCalledTimes(1);
        expect(resultQueue.submitBatch.mock.calls[0][0]).toHaveLength(2);
        expect(resultQueue.submitBatch.mock.calls[0][1]).toMatchObject({ retries: 0 });
        await runtime.shutdown('test');
    });

    it('fast lane runs on-demand checks and the main poll skips them while in flight', async () => {
        let releaseCheck;
        const gate = new Promise((resolve) => { releaseCheck = resolve; });
        const registry = new CheckRegistry().register('fake', {
            capability: 'fake',
            budget: 'network',
            validate: (raw) => raw,
            handler: async (monitor) => {
                await gate;
                return { monitor_id: monitor.id, is_success: true, response_time_ms: 1 };
            },
        });
        const adhoc = { id: -5, type: 'fake', timeout: 1 };
        const api = {
            getAdhocChecks: vi.fn().mockResolvedValue({ monitors: [adhoc] }),
            getChecks: vi.fn().mockResolvedValue({ monitors: [adhoc] }),
            close: vi.fn(),
        };
        const resultQueue = {
            submitBatch: vi.fn().mockResolvedValue(true),
            flush: vi.fn().mockResolvedValue(true),
            dropOldest: vi.fn().mockReturnValue(0),
            size: 0,
            telemetry: { size: 0, bytes: 0, counters: {} },
        };
        const runtime = new AgentRuntime({
            config: baseConfig({ ADHOC_POLL_INTERVAL: 10_000, REPORT_BATCH_MAX_SIZE: 50, REPORT_COALESCE_IDLE_MS: 5000 }),
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            registry,
            api,
            resultQueue,
            version: 'test',
        });

        const lane = runtime.runAdhocLoop();
        await vi.waitFor(() => expect(runtime.adhocInFlight.has(-5)).toBe(true));

        // Main poll carries the same leg (older console path): must not rerun it.
        await runtime.pollOnce();

        releaseCheck();
        // Reported immediately, not after the 5s coalescing window.
        await vi.waitFor(() => expect(resultQueue.submitBatch).toHaveBeenCalledTimes(1));
        expect(resultQueue.submitBatch.mock.calls[0][0]).toEqual([
            expect.objectContaining({ monitor_id: -5, is_success: true }),
        ]);
        expect(runtime.state.totalChecks).toBe(1);

        await runtime.shutdown('test');
        await lane;
    });

    it('fast lane retires quietly on a console without the endpoint', async () => {
        const { runtime, api } = createRuntime({
            getAdhocChecks: vi.fn().mockRejectedValue({ response: { status: 404 } }),
        }, { ADHOC_POLL_INTERVAL: 10 });

        await runtime.runAdhocLoop();
        expect(api.getAdhocChecks).toHaveBeenCalledTimes(1);
        await runtime.shutdown('test');
    });

    it('a slow check does not hold back the next poll', async () => {
        let releaseSlow;
        const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
        const started = [];
        const registry = new CheckRegistry().register('fake', {
            capability: 'fake',
            budget: 'network',
            validate: (raw) => raw,
            handler: async (monitor) => {
                started.push(monitor.id);
                if (monitor.id === 1) await slowGate;
                return { monitor_id: monitor.id, is_success: true, response_time_ms: 1 };
            },
        });
        const api = {
            getChecks: vi.fn()
                .mockResolvedValueOnce({ monitors: [{ id: 1, type: 'fake', timeout: 30 }] })
                .mockResolvedValueOnce({ monitors: [{ id: 2, type: 'fake', timeout: 30 }] }),
            close: vi.fn(),
        };
        const resultQueue = {
            submitBatch: vi.fn().mockResolvedValue(true),
            flush: vi.fn().mockResolvedValue(true),
            dropOldest: vi.fn().mockReturnValue(0),
            size: 0,
            telemetry: { size: 0, bytes: 0, counters: {} },
        };
        const runtime = new AgentRuntime({
            config: baseConfig({ CONCURRENCY_LIMIT: 4, NETWORK_CONCURRENCY: 4 }),
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            registry,
            api,
            resultQueue,
            version: 'test',
        });

        // The first poll returns while monitor 1 is still running.
        await runtime.pollOnce();
        expect(started).toEqual([1]);

        // So the second poll runs right away and monitor 2 is not blocked.
        await runtime.pollOnce();
        await vi.waitFor(() => expect(started).toEqual([1, 2]));
        // Monitor 2 settles while monitor 1 is still running.
        await vi.waitFor(() => expect(runtime.state.totalChecks).toBe(1));

        releaseSlow();
        await runtime.idle();
        expect(runtime.state.totalChecks).toBe(2);
        await runtime.shutdown('test');
    });

    it('does not start a scheduled leg twice while it is still running', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const handler = vi.fn(async (monitor) => {
            await gate;
            return { monitor_id: monitor.id, is_success: true, response_time_ms: 1 };
        });
        const registry = new CheckRegistry().register('fake', {
            capability: 'fake',
            budget: 'network',
            validate: (raw) => raw,
            handler,
        });
        const leg = { id: 9, type: 'fake', timeout: 30, family: 'ipv4' };
        const otherFamily = { id: 9, type: 'fake', timeout: 30, family: 'ipv6' };
        const api = {
            getChecks: vi.fn()
                .mockResolvedValueOnce({ monitors: [leg] })
                .mockResolvedValueOnce({ monitors: [leg, otherFamily] }),
            close: vi.fn(),
        };
        const resultQueue = {
            submitBatch: vi.fn().mockResolvedValue(true),
            flush: vi.fn().mockResolvedValue(true),
            dropOldest: vi.fn().mockReturnValue(0),
            size: 0,
            telemetry: { size: 0, bytes: 0, counters: {} },
        };
        const runtime = new AgentRuntime({
            config: baseConfig({ CONCURRENCY_LIMIT: 4, NETWORK_CONCURRENCY: 4 }),
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            registry,
            api,
            resultQueue,
            version: 'test',
        });

        await runtime.pollOnce();
        await runtime.pollOnce();
        // The ipv4 leg is still running, so only the ipv6 leg is added.
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
        expect(handler.mock.calls.map(([monitor]) => monitor.family)).toEqual(['ipv4', 'ipv6']);

        release();
        await runtime.idle();
        expect(runtime.scheduledInFlight.size).toBe(0);
        await runtime.shutdown('test');
    });

    it('starts a leg with due_at at its due time, not on receipt', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        try {
            const started = [];
            const registry = new CheckRegistry().register('fake', {
                capability: 'fake',
                budget: 'network',
                validate: (raw) => raw,
                handler: async (monitor) => {
                    started.push(monitor.id);
                    return { monitor_id: monitor.id, is_success: true, response_time_ms: 1 };
                },
            });
            const now = Date.now();
            const response = {
                server_time: now,
                monitors: [{ id: 3, type: 'fake', timeout: 5, due_at: now + 2_000, slot_id: 'abc', interval_seconds: 30 }],
            };
            Object.defineProperty(response, 'timing', { value: { sentAt: now, receivedAt: now } });
            const resultQueue = {
                submitBatch: vi.fn().mockResolvedValue(true),
                flush: vi.fn().mockResolvedValue(true),
                dropOldest: vi.fn().mockReturnValue(0),
                size: 0,
                telemetry: { size: 0, bytes: 0, counters: {} },
            };
            const runtime = new AgentRuntime({
                config: baseConfig({ REPORT_COALESCE_IDLE_MS: 10 }),
                logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
                registry,
                api: { getChecks: vi.fn().mockResolvedValue(response), close: vi.fn() },
                resultQueue,
                version: 'test',
            });

            await runtime.pollOnce();
            expect(started).toEqual([]);
            expect(runtime.scheduledInFlight.has('3:')).toBe(true);

            await vi.advanceTimersByTimeAsync(1_999);
            expect(started).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            expect(started).toEqual([3]);

            await vi.advanceTimersByTimeAsync(20);
            await vi.waitFor(() => expect(resultQueue.submitBatch).toHaveBeenCalledTimes(1));
            expect(resultQueue.submitBatch.mock.calls[0][0][0]).toMatchObject({
                monitor_id: 3,
                slot_id: 'abc',
                scheduled_at: now + 2_000,
                started_at: now + 2_000,
            });
            expect(runtime.healthPayload().schedule.start_delay_ms.p50).toBe(0);
            await runtime.shutdown('test');
        } finally {
            vi.useRealTimers();
        }
    });

    it('holds a leg until its report request has finished', async () => {
        let deliver;
        const delivered = new Promise((resolve) => { deliver = resolve; });
        const handler = vi.fn(async (monitor) => ({ monitor_id: monitor.id, is_success: true, response_time_ms: 1 }));
        const registry = new CheckRegistry().register('fake', {
            capability: 'fake', budget: 'network', validate: (raw) => raw, handler,
        });
        const leg = { id: 4, type: 'fake', timeout: 5, family: 'ipv4' };
        const resultQueue = {
            submitBatch: vi.fn(() => delivered),
            flush: vi.fn().mockResolvedValue(true),
            dropOldest: vi.fn().mockReturnValue(0),
            size: 0,
            telemetry: { size: 0, bytes: 0, counters: {} },
        };
        const runtime = new AgentRuntime({
            config: baseConfig({ REPORT_COALESCE_IDLE_MS: 1 }),
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            registry,
            api: { getChecks: vi.fn().mockResolvedValue({ monitors: [leg] }), close: vi.fn() },
            resultQueue,
            version: 'test',
        });

        await runtime.pollOnce();
        await vi.waitFor(() => expect(resultQueue.submitBatch).toHaveBeenCalledTimes(1));
        // Result is in, report not yet acknowledged: a poll must not rerun it.
        await runtime.pollOnce();
        expect(handler).toHaveBeenCalledTimes(1);
        expect(runtime.scheduledInFlight.has('4:ipv4')).toBe(true);

        deliver(true);
        await runtime.idle();
        await vi.waitFor(() => expect(runtime.scheduledInFlight.size).toBe(0));
        await runtime.shutdown('test');
    });

    it('skips a slot that is a full interval late instead of running it', () => {
        const { runtime } = createRuntime();
        const leg = { id: 5, type: 'fake', timeout: 5, interval_seconds: 30, due_at: 0 };
        runtime.scheduledInFlight.add('5:');
        runtime.clock.offsetMs = 31_000 - Date.now();
        runtime.startDue([{ dueAt: 0, item: leg }]);
        expect(runtime.state.skippedSlots).toBe(1);
        expect(runtime.inFlightRuns.size).toBe(0);
        expect(runtime.scheduledInFlight.size).toBe(0);
    });

    it('executes registered checks and submits settled results', async () => {
        const { runtime, resultQueue } = createRuntime({
            getChecks: vi.fn().mockResolvedValue({
                monitors: [{ id: 7, type: 'fake', timeout: 1 }],
            }),
        });

        await runtime.pollOnce();
        await runtime.idle();
        expect(resultQueue.submitBatch).toHaveBeenCalledWith(
            [expect.objectContaining({ monitor_id: 7, is_success: true })],
            expect.objectContaining({ signal: expect.any(AbortSignal), retries: 0 }),
        );
        expect(runtime.state.totalChecks).toBe(1);
        await runtime.shutdown('test');
    });
});
