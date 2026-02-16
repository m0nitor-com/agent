import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import ApiClient from './lib/api.js';
import checkHttp from './checks/http.js';
import checkPing from './checks/ping.js';
import checkTcp from './checks/tcp.js';
import checkDns from './checks/dns.js';
import checkUdp from './checks/udp.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

// Get current version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const CURRENT_VERSION = pkg.version;

logger.info(`[m0nitor Agent] Starting up v${CURRENT_VERSION}...`);
logger.info(`[CONFIG] API URL: ${config.API_URL}`);
logger.info(`[CONFIG] Poll Interval: ${config.POLL_INTERVAL}ms`);

// Initialize API client
const api = new ApiClient(config.API_URL, config.PROBE_TOKEN);

// Health state
let lastPollSuccess = false;
let lastPollTime = null;
let totalChecks = 0;
let latestAvailableVersion = null;

/**
 * Execute a check based on monitor type
 */
async function executeCheck(monitor) {
    logger.debug(`[CHECK] Executing ${monitor.type} check for ${monitor.name}`);

    let result;

    try {
        switch (monitor.type) {
            case 'http':
            case 'https':
                result = await checkHttp(monitor);
                break;
            case 'ping':
                result = await checkPing(monitor);
                break;
            case 'tcp':
            case 'ssh':
                result = await checkTcp(monitor);
                break;
            case 'udp':
                result = await checkUdp(monitor);
                break;
            case 'dns':
                result = await checkDns(monitor);
                break;
            default:
                logger.warn(`[CHECK] Unknown monitor type: ${monitor.type}`);
                result = {
                    monitor_id: monitor.id,
                    is_success: false,
                    error_type: 'unsupported',
                    error_message: `Monitor type ${monitor.type} is not supported`,
                };
        }
    } catch (err) {
        logger.error({ err }, `[CHECK] Unexpected error executing ${monitor.type} check`);
        result = {
            monitor_id: monitor.id,
            is_success: false,
            error_type: 'worker_error',
            error_message: `Worker execution error: ${err.message}`,
        };
    }

    return result;
}

/**
 * Main polling loop
 */
async function pollAndCheck() {
    try {
        // Fetch monitors that need checking
        const data = await api.getChecks();

        lastPollSuccess = true;
        lastPollTime = new Date();

        if (!data.monitors || data.monitors.length === 0) {
            logger.debug('[POLL] No monitors to check');
            return;
        }

        logger.info(`[POLL] Got ${data.monitors.length} monitor(s) to check from ${data.location.code}`);

        // Check for version updates
        if (data.worker?.latest_version && data.worker.latest_version !== CURRENT_VERSION) {
            if (latestAvailableVersion !== data.worker.latest_version) {
                latestAvailableVersion = data.worker.latest_version;
                logger.warn(`[UPDATE] A newer agent version is available: v${data.worker.latest_version} (current: v${CURRENT_VERSION}). Please update your Docker image.`);
            }
        }

        // Execute checks in parallel (with concurrency limit)
        const concurrency = 30;
        const monitors = data.monitors;

        for (let i = 0; i < monitors.length; i += concurrency) {
            const batch = monitors.slice(i, i + concurrency);
            const results = await Promise.all(
                batch.map(async (monitor) => {
                    try {
                        const result = await executeCheck(monitor);
                        // Attach batch token if present
                        if (result && monitor.batch_token) {
                            result.batch_token = monitor.batch_token;
                        }
                        return result;
                    } catch (error) {
                        logger.error({ err: error, monitor: monitor.name }, `[CHECK] Error checking ${monitor.name}`);
                        return {
                            monitor_id: monitor.id,
                            is_success: false,
                            error_type: 'worker_error',
                            error_message: `Worker error: ${error.message}`,
                            batch_token: monitor.batch_token,
                        };
                    }
                })
            );

            // Report results
            for (const result of results) {
                try {
                    const status = result.is_success ? '✓' : '✗';
                    logger.info(`[REPORT] ${status} Monitor #${result.monitor_id}: ${result.response_time_ms || 0}ms`);
                    await api.reportCheck(result);
                    totalChecks++;
                } catch (error) {
                    logger.error({ err: error, monitor_id: result.monitor_id }, `[REPORT] Failed to report result`);
                }
            }
        }

    } catch (error) {
        lastPollSuccess = false;
        if (error.response?.status === 401) {
            logger.fatal('[ERROR] Invalid or expired probe token');
            process.exit(1);
        } else {
            logger.error({ err: error }, '[POLL] Error in poll cycle');
        }
    }
}

/**
 * Start health check HTTP server
 */
function startHealthServer() {
    const port = parseInt(process.env.HEALTH_PORT || '8080', 10);

    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/healthz') {
            const healthy = lastPollSuccess || lastPollTime === null; // healthy if never polled yet (still starting)
            const status = healthy ? 200 : 503;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: healthy ? 'ok' : 'unhealthy',
                version: CURRENT_VERSION,
                uptime: process.uptime(),
                last_poll: lastPollTime?.toISOString() || null,
                last_poll_success: lastPollSuccess,
                total_checks: totalChecks,
            }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(port, () => {
        logger.info(`[HEALTH] Health endpoint listening on :${port}/health`);
    });

    return server;
}

/**
 * Verify API connectivity before starting main loop
 */
async function verifyConnectivity() {
    logger.info('[STARTUP] Verifying API connectivity...');
    try {
        await api.getChecks();
        logger.info('[STARTUP] API connection verified successfully');
    } catch (error) {
        if (error.response?.status === 401) {
            logger.fatal('[STARTUP] Invalid probe token — check your PROBE_TOKEN configuration');
            process.exit(1);
        }
        logger.warn({ err: error }, '[STARTUP] API connection failed — will retry during polling');
    }
}

/**
 * Start the worker
 */
async function start() {
    // Start health server
    startHealthServer();

    // Verify connectivity
    await verifyConnectivity();

    logger.info('[m0nitor Agent] Agent started successfully');

    // Self-scheduling poll loop (prevents drift/overlap)
    async function schedulePoll() {
        await pollAndCheck();
        setTimeout(schedulePoll, config.POLL_INTERVAL);
    }

    // Start first poll
    schedulePoll();

    // Handle graceful shutdown
    const shutdown = () => {
        logger.info('[m0nitor Agent] Shutting down...');
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

// Start the worker
start().catch((error) => {
    logger.fatal({ err: error }, '[FATAL] Failed to start agent');
    process.exit(1);
});
