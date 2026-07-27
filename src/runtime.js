import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { computeNextPollDelay } from './lib/backoff.js';
import { executeWithContext } from './lib/execution-context.js';
import { FairScheduler } from './lib/fair-scheduler.js';
import { closeHttpCheckAgents } from './lib/http-agent-pool.js';
import { ReportCoalescer } from './lib/report-coalescer.js';
import { ResourceGovernor } from './lib/resource-governor.js';
import {
    CHECK_WATCHDOG_BUFFER_MS,
    DEFAULT_MONITOR_TIMEOUT_S,
    EVENT_LOOP_DELAY_RESOLUTION_MS,
    GOVERNOR_TICK_INTERVAL_MS,
    HEALTH_RESPONSE_MAX_BYTES,
    HEALTH_UNHEALTHY_AFTER_FAILED_POLLS,
    MAX_MONITOR_TIMEOUT_S,
    MIN_MONITOR_TIMEOUT_S,
    REPORT_COALESCE_IDLE_MS,
    REPORT_MAX_IN_FLIGHT,
    SETTLE_LOG_SAMPLE_RATE,
} from './lib/constants.js';

function safeError(error) {
    return {
        code: typeof error?.code === 'string' ? error.code.slice(0, 40) : undefined,
        status: Number.isInteger(error?.response?.status) ? error.response.status : undefined,
        name: typeof error?.name === 'string' ? error.name.slice(0, 40) : undefined,
    };
}

function interruptibleDelay(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted || ms <= 0) {
            resolve();
            return;
        }
        const timer = setTimeout(done, ms);
        timer.unref?.();
        function done() {
            signal.removeEventListener('abort', done);
            clearTimeout(timer);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}

function monitorTimeoutMs(monitor) {
    const timeoutSeconds = Math.min(
        MAX_MONITOR_TIMEOUT_S,
        Math.max(MIN_MONITOR_TIMEOUT_S, Number(monitor.timeout) || DEFAULT_MONITOR_TIMEOUT_S),
    );
    return timeoutSeconds * 1000 + CHECK_WATCHDOG_BUFFER_MS;
}

export class AgentRuntime {
    constructor({ config, logger, registry, api, resultQueue, version, budgets = null }) {
        this.config = config;
        this.logger = logger;
        this.registry = registry;
        this.api = api;
        this.resultQueue = resultQueue;
        this.version = version;
        this.budgets = budgets;
        this.shutdownController = new AbortController();
        this.healthServer = null;
        this.loopPromise = null;
        this.currentPoll = null;
        this.isPolling = false;
        this.isShuttingDown = false;
        this.governorTimer = null;
        this.eventLoopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS });
        this.eventLoopDelay.enable();
        this.state = {
            consecutiveFailedPolls: 0,
            lastSuccessfulPollAt: null,
            lastPollAttemptAt: null,
            totalChecks: 0,
            checkFailures: 0,
            validationFailures: 0,
            pollOverlapSkips: 0,
            settleLogCounter: 0,
            active: { total: 0, network: 0, database: 0, diagnostic: 0 },
            queueDepth: 0,
            latestAvailableVersion: null,
            governorSaturated: false,
        };
        this.scheduler = new FairScheduler({
            total: config.CONCURRENCY_LIMIT,
            network: config.NETWORK_CONCURRENCY,
            database: config.DATABASE_CONCURRENCY,
            diagnostic: config.DIAGNOSTIC_CONCURRENCY,
            onStateChange: ({ active, queued }) => {
                this.state.active = active;
                this.state.queueDepth = queued;
            },
        });
        this.coalescer = new ReportCoalescer(resultQueue, {
            maxCount: config.REPORT_BATCH_MAX_SIZE,
            maxBytes: config.REPORT_BATCH_MAX_BYTES,
            idleMs: config.REPORT_COALESCE_IDLE_MS || REPORT_COALESCE_IDLE_MS,
            maxInFlight: config.REPORT_MAX_IN_FLIGHT || REPORT_MAX_IN_FLIGHT,
        });
        this.governor = new ResourceGovernor({
            baseLimits: {
                total: config.CONCURRENCY_LIMIT,
                network: config.NETWORK_CONCURRENCY,
                database: config.DATABASE_CONCURRENCY,
                diagnostic: config.DIAGNOSTIC_CONCURRENCY,
            },
            softRssBytes: config.SOFT_RSS_BYTES,
            hardRssBytes: config.HARD_RSS_BYTES,
            getEventLoopP99Ms: () => this.eventLoopDelay.percentile(99) / 1e6,
            getRssBytes: () => process.memoryUsage().rss,
            logger: this.logger,
            onLimitsChange: (limits, reason) => {
                this.scheduler.setLimits(limits);
                if (reason === 'rss_hard') {
                    this.scheduler.setPaused(true);
                } else if (this.governor.paused === false) {
                    this.scheduler.setPaused(false);
                }
            },
            onHardPressure: () => {
                this.state.governorSaturated = true;
                this.scheduler.setPaused(true);
                this.resultQueue.dropOldest?.(Math.max(1, Math.ceil(this.resultQueue.size * 0.1) || 1));
            },
            onRestore: () => {
                this.state.governorSaturated = false;
                this.scheduler.setPaused(false);
            },
        });
    }

    validateConfiguration() {
        const positive = [
            'POLL_INTERVAL',
            'POLL_MAX_INTERVAL',
            'CONCURRENCY_LIMIT',
            'NETWORK_CONCURRENCY',
            'DATABASE_CONCURRENCY',
            'DIAGNOSTIC_CONCURRENCY',
            'RESULT_QUEUE_MAX_BYTES',
            'REPORT_BATCH_MAX_BYTES',
            'SHUTDOWN_FLUSH_TIMEOUT',
        ];
        for (const key of positive) {
            if (!Number.isFinite(this.config[key]) || this.config[key] < 1) {
                throw new Error(`${key} must be a positive number`);
            }
        }
        if (this.config.POLL_MAX_INTERVAL < this.config.POLL_INTERVAL) {
            throw new Error('POLL_MAX_INTERVAL must be greater than or equal to POLL_INTERVAL');
        }
        if (this.config.HARD_RSS_BYTES <= this.config.SOFT_RSS_BYTES) {
            throw new Error('HARD_RSS_BYTES must be greater than SOFT_RSS_BYTES');
        }
    }

    async executeCheck(monitor) {
        const entry = this.registry.get(monitor.type);
        if (!entry) {
            return {
                monitor_id: monitor.id,
                is_success: false,
                error_type: 'unsupported',
                error_message: `Monitor type ${monitor.type} is not supported`,
            };
        }

        const result = await executeWithContext({
            monitor,
            handler: entry.handler,
            timeoutMs: monitorTimeoutMs(monitor),
            logger: this.logger,
            parentSignal: this.shutdownController.signal,
        });

        if (monitor.batch_token) result.batch_token = monitor.batch_token;
        if (result.family == null && monitor.family) result.family = monitor.family;
        return result;
    }

    logSettled(result) {
        this.state.settleLogCounter++;
        const sampleHit = this.state.settleLogCounter % SETTLE_LOG_SAMPLE_RATE === 0;
        const payload = {
            monitor_id: result?.monitor_id,
            success: result?.is_success === true,
            response_time_ms: result?.response_time_ms || 0,
            error_type: result?.error_type || null,
        };
        if (sampleHit) {
            this.logger.info(payload, '[CHECK] Settled');
        } else {
            this.logger.debug(payload, '[CHECK] Settled');
        }
    }

    async pollOnce() {
        if (this.isPolling || this.isShuttingDown) {
            this.state.pollOverlapSkips++;
            return null;
        }
        this.isPolling = true;
        this.state.lastPollAttemptAt = new Date();

        try {
            const data = await this.api.getChecks({
                signal: this.shutdownController.signal,
                health: this.healthPayload(),
            });
            this.state.consecutiveFailedPolls = 0;
            this.state.lastSuccessfulPollAt = new Date();

            if (data.worker?.latest_version && data.worker.latest_version !== this.version) {
                if (this.state.latestAvailableVersion !== data.worker.latest_version) {
                    this.state.latestAvailableVersion = data.worker.latest_version;
                    this.logger.warn({
                        available_version: data.worker.latest_version,
                        current_version: this.version,
                    }, '[UPDATE] A newer agent version is available');
                }
            }

            const rawMonitors = Array.isArray(data.monitors) ? data.monitors : [];
            const monitors = [];
            for (const raw of rawMonitors) {
                const validated = this.registry.validate(raw);
                if (validated.ok) {
                    monitors.push(validated.monitor);
                } else {
                    this.state.validationFailures++;
                    this.logger.warn({
                        monitor_id: raw?.id,
                        type: typeof raw?.type === 'string' ? raw.type.slice(0, 30) : null,
                    }, '[VALIDATOR] Skipping invalid monitor');
                }
            }
            if (monitors.length === 0) return data.poll_after_ms || null;

            this.logger.info({
                checks: monitors.length,
                location: data.location?.code,
            }, '[POLL] Received checks');

            await this.scheduler.run(
                monitors,
                (monitor) => this.registry.budgetFor(monitor.type),
                (monitor) => this.executeCheck(monitor),
                {
                    onResult: (result) => {
                        this.state.totalChecks++;
                        if (!result?.is_success) this.state.checkFailures++;
                        this.logSettled(result);
                        this.coalescer.push(result, { signal: this.shutdownController.signal });
                    },
                },
            );
            await this.coalescer.flush({ signal: this.shutdownController.signal });
            return data.poll_after_ms || null;
        } catch (error) {
            if (this.isShuttingDown || this.shutdownController.signal.aborted) return null;
            this.state.consecutiveFailedPolls++;
            if (error.response?.status === 401) {
                error.fatalAuthentication = true;
            }
            this.logger.error({
                failures: this.state.consecutiveFailedPolls,
                ...safeError(error),
            }, '[POLL] Poll cycle failed');
            throw error;
        } finally {
            this.isPolling = false;
        }
    }

    async runLoop() {
        while (!this.isShuttingDown) {
            let pollHint = null;
            try {
                this.currentPoll = this.pollOnce();
                pollHint = await this.currentPoll;
            } catch (error) {
                if (error.fatalAuthentication) throw error;
            } finally {
                this.currentPoll = null;
            }

            const backoff = computeNextPollDelay(
                this.config.POLL_INTERVAL,
                this.config.POLL_MAX_INTERVAL,
                this.state.consecutiveFailedPolls,
            );
            const delay = Number.isFinite(pollHint)
                ? Math.max(250, Math.min(backoff, pollHint))
                : backoff;
            await interruptibleDelay(delay, this.shutdownController.signal);
        }
    }

    healthPayload() {
        const memory = process.memoryUsage();
        const failedPolls = this.state.consecutiveFailedPolls;
        const governor = this.governor.telemetry();
        const saturated = this.state.governorSaturated
            || governor.saturated
            || (this.state.queueDepth > 0
                && this.state.active.total >= this.scheduler.limits.total);
        const healthy = !this.isShuttingDown
            && failedPolls < HEALTH_UNHEALTHY_AFTER_FAILED_POLLS;
        return {
            status: healthy ? 'ok' : 'unhealthy',
            version: this.version,
            contract_version: 2,
            uptime_seconds: Math.floor(process.uptime()),
            shutting_down: this.isShuttingDown,
            active_checks: { ...this.state.active },
            check_queue_depth: this.state.queueDepth,
            result_queue: this.resultQueue.telemetry,
            report_coalescer: this.coalescer.telemetry,
            governor,
            saturated,
            memory: {
                rss_bytes: memory.rss,
                heap_used_bytes: memory.heapUsed,
                heap_total_bytes: memory.heapTotal,
                external_bytes: memory.external,
            },
            event_loop: {
                mean_delay_ms: Number((this.eventLoopDelay.mean / 1e6).toFixed(3)),
                p99_delay_ms: Number((this.eventLoopDelay.percentile(99) / 1e6).toFixed(3)),
                max_delay_ms: Number((this.eventLoopDelay.max / 1e6).toFixed(3)),
            },
            active_handles: process._getActiveHandles?.().length ?? null,
            last_successful_poll: this.state.lastSuccessfulPollAt?.toISOString() || null,
            last_poll_attempt: this.state.lastPollAttemptAt?.toISOString() || null,
            consecutive_failed_polls: failedPolls,
            counters: {
                total_checks: this.state.totalChecks,
                failed_checks: this.state.checkFailures,
                validation_failures: this.state.validationFailures,
                poll_overlap_skips: this.state.pollOverlapSkips,
            },
        };
    }

    startHealthServer() {
        this.healthServer = http.createServer((req, res) => {
            if (req.url !== '/health' && req.url !== '/healthz') {
                res.writeHead(404);
                res.end();
                return;
            }
            const payload = this.healthPayload();
            const body = JSON.stringify(payload);
            if (Buffer.byteLength(body) > HEALTH_RESPONSE_MAX_BYTES) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end('{"status":"unhealthy","error":"health_payload_limit"}');
                return;
            }
            res.writeHead(payload.status === 'ok' ? 200 : 503, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            });
            res.end(body);
        });
        this.healthServer.listen(this.config.HEALTH_PORT, () => {
            this.logger.info({ port: this.config.HEALTH_PORT }, '[HEALTH] Health endpoint listening');
        });
    }

    startGovernor() {
        if (this.governorTimer) return;
        this.governorTimer = setInterval(() => {
            if (this.isShuttingDown) return;
            this.governor.tick();
        }, GOVERNOR_TICK_INTERVAL_MS);
        this.governorTimer.unref?.();
    }

    async start() {
        this.validateConfiguration();
        this.startHealthServer();
        this.startGovernor();
        this.logger.info({
            version: this.version,
            sku: this.budgets?.sku || null,
            resources: this.budgets?.detected || null,
            concurrency: {
                total: this.config.CONCURRENCY_LIMIT,
                network: this.config.NETWORK_CONCURRENCY,
                database: this.config.DATABASE_CONCURRENCY,
                diagnostic: this.config.DIAGNOSTIC_CONCURRENCY,
            },
            http_pool: {
                max_sockets: this.config.HTTP_MAX_SOCKETS,
                max_free_sockets: this.config.HTTP_MAX_FREE_SOCKETS,
            },
            queue: {
                max_entries: this.config.RESULT_QUEUE_MAX_ENTRIES,
                max_bytes: this.config.RESULT_QUEUE_MAX_BYTES,
                batch_size: this.config.REPORT_BATCH_MAX_SIZE,
                batch_bytes: this.config.REPORT_BATCH_MAX_BYTES,
            },
            governor: {
                soft_rss_bytes: this.config.SOFT_RSS_BYTES,
                hard_rss_bytes: this.config.HARD_RSS_BYTES,
            },
        }, '[AGENT] Started');
        this.loopPromise = this.runLoop();
        return this.loopPromise;
    }

    async shutdown(reason = 'signal') {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        this.logger.info({ reason }, '[AGENT] Graceful shutdown started');
        this.shutdownController.abort(new Error(`Agent shutdown: ${reason}`));

        if (this.governorTimer) {
            clearInterval(this.governorTimer);
            this.governorTimer = null;
        }
        this.coalescer.stop();
        if (this.healthServer) {
            await new Promise((resolve) => this.healthServer.close(resolve));
        }
        if (this.currentPoll) {
            try { await this.currentPoll; } catch { /* poll error already recorded */ }
        }
        await this.coalescer.flush({ signal: AbortSignal.timeout?.(this.config.SHUTDOWN_FLUSH_TIMEOUT) });
        const flushed = await this.resultQueue.flush(this.config.SHUTDOWN_FLUSH_TIMEOUT);
        closeHttpCheckAgents();
        this.api.close();
        this.eventLoopDelay.disable();
        this.logger.info({
            result_flush_complete: flushed,
            remaining_results: this.resultQueue.size,
        }, '[AGENT] Graceful shutdown complete');
    }
}
