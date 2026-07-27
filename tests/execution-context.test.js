import { describe, expect, it, vi } from 'vitest';
import { executeWithContext } from '../src/lib/execution-context.js';

const logger = { warn: vi.fn() };

describe('executeWithContext', () => {
    it('aborts a timed out handler and awaits cleanup exactly once', async () => {
        let cleanupCount = 0;
        let observedAbort = false;

        const result = await executeWithContext({
            monitor: { id: 10, type: 'test' },
            timeoutMs: 20,
            logger,
            handler: async (_monitor, context) => {
                context.cleanup.add(async () => {
                    cleanupCount++;
                });
                await new Promise((resolve) => {
                    context.signal.addEventListener('abort', () => {
                        observedAbort = true;
                        resolve();
                    }, { once: true });
                });
                context.throwIfAborted();
            },
        });

        expect(result).toMatchObject({
            monitor_id: 10,
            is_success: false,
            error_type: 'timeout',
        });
        expect(observedAbort).toBe(true);
        expect(cleanupCount).toBe(1);
    });

    it('runs LIFO cleanup after successful settlement', async () => {
        const order = [];
        const result = await executeWithContext({
            monitor: { id: 11, type: 'test' },
            timeoutMs: 100,
            logger,
            handler: async (_monitor, context) => {
                context.cleanup.add(() => order.push('first'));
                context.cleanup.add(() => order.push('second'));
                return { monitor_id: 11, is_success: true };
            },
        });

        expect(result.is_success).toBe(true);
        expect(order).toEqual(['second', 'first']);
    });
});
