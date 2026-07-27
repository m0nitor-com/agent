import { performance } from 'node:perf_hooks';

const MAX_CLEANUP_HOOKS = 32;

export class CheckTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`Check timed out after ${timeoutMs}ms`);
        this.name = 'CheckTimeoutError';
        this.code = 'CHECK_TIMEOUT';
        this.timeoutMs = timeoutMs;
    }
}

export class CleanupStack {
    constructor() {
        this.hooks = [];
        this.closed = false;
        this.closePromise = null;
    }

    add(hook) {
        if (typeof hook !== 'function') {
            throw new TypeError('Cleanup hook must be a function');
        }
        if (this.closed) {
            try {
                void hook();
            } catch {
                // The owning execution has already been aborted. Best effort is
                // safer than retaining a resource created during the abort race.
            }
            return () => {};
        }
        if (this.hooks.length >= MAX_CLEANUP_HOOKS) {
            throw new Error(`Cleanup hook limit of ${MAX_CLEANUP_HOOKS} exceeded`);
        }

        let active = true;
        this.hooks.push(async () => {
            if (!active) return;
            active = false;
            await hook();
        });

        return () => {
            active = false;
        };
    }

    async close() {
        if (this.closePromise) return this.closePromise;
        this.closed = true;

        this.closePromise = (async () => {
            const errors = [];
            while (this.hooks.length > 0) {
                const hook = this.hooks.pop();
                try {
                    await hook();
                } catch (error) {
                    errors.push(error);
                }
            }
            return errors;
        })();
        return this.closePromise;
    }
}

export function createExecutionContext({
    monitor,
    timeoutMs,
    logger,
    parentSignal,
    target = null,
}) {
    const controller = new AbortController();
    const cleanup = new CleanupStack();
    const startedAt = performance.now();
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    let abortSettlementAllowed = false;

    const abortFromParent = () => {
        controller.abort(parentSignal?.reason || new Error('Agent is shutting down'));
    };

    if (parentSignal) {
        if (parentSignal.aborted) {
            abortFromParent();
        } else {
            parentSignal.addEventListener('abort', abortFromParent, { once: true });
            cleanup.add(() => parentSignal.removeEventListener('abort', abortFromParent));
        }
    }

    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new CheckTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    cleanup.add(() => clearTimeout(timer));
    controller.signal.addEventListener('abort', () => {
        void cleanup.close();
    }, { once: true });

    return {
        monitor,
        signal: controller.signal,
        deadline,
        logger,
        target,
        cleanup,
        abort: (reason) => controller.abort(reason),
        get timedOut() {
            return timedOut;
        },
        elapsedMs: () => Math.max(0, Math.round(performance.now() - startedAt)),
        remainingMs: () => Math.max(0, deadline - Date.now()),
        allowAbortSettlement: () => {
            abortSettlementAllowed = true;
        },
        get abortSettlementAllowed() {
            return abortSettlementAllowed;
        },
        throwIfAborted: () => {
            if (controller.signal.aborted) {
                throw controller.signal.reason || new Error('Check aborted');
            }
        },
    };
}

export async function executeWithContext({
    monitor,
    handler,
    timeoutMs,
    logger,
    parentSignal,
    target,
}) {
    const context = createExecutionContext({
        monitor,
        timeoutMs,
        logger,
        parentSignal,
        target,
    });

    let result;
    let executionError = null;

    try {
        result = await handler(monitor, context);
        if (!context.abortSettlementAllowed) context.throwIfAborted();
    } catch (error) {
        executionError = error;
    }

    const cleanupErrors = await context.cleanup.close();
    if (cleanupErrors.length > 0) {
        logger.warn({
            monitor_id: monitor.id,
            type: monitor.type,
            cleanup_errors: cleanupErrors.length,
        }, '[CHECK] Resource cleanup reported errors');
    }

    if (executionError) {
        const isTimeout = context.timedOut
            || executionError?.code === 'CHECK_TIMEOUT'
            || executionError?.name === 'AbortError';
        return {
            monitor_id: monitor.id,
            is_success: false,
            response_time_ms: context.elapsedMs(),
            error_type: isTimeout ? 'timeout' : 'worker_error',
            error_message: isTimeout
                ? `Check timed out after ${timeoutMs}ms`
                : 'Worker execution failed',
        };
    }

    return result;
}
