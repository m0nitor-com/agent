import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgets, config, resources } from './lib/config.js';
import { logger } from './lib/logger.js';
import ApiClient from './lib/api.js';
import { ResultQueue } from './lib/result-queue.js';
import { createRegistry } from './lib/registry-factory.js';
import { configureHttpCheckAgents } from './lib/http-agent-pool.js';
import { AgentRuntime } from './runtime.js';

const currentFile = fileURLToPath(import.meta.url);
const packageJson = JSON.parse(readFileSync(join(dirname(currentFile), '..', 'package.json'), 'utf8'));
const version = packageJson.version;

configureHttpCheckAgents({
    maxSockets: config.HTTP_MAX_SOCKETS,
    maxFreeSockets: config.HTTP_MAX_FREE_SOCKETS,
});

logger.info({
    sku: budgets.sku,
    cpus: resources.cpus,
    memory_bytes: resources.memoryBytes,
    memory_gib: Number(resources.memoryGiB.toFixed(3)),
    source: resources.source,
    budgets: {
        total: config.CONCURRENCY_LIMIT,
        network: config.NETWORK_CONCURRENCY,
        database: config.DATABASE_CONCURRENCY,
        diagnostic: config.DIAGNOSTIC_CONCURRENCY,
        http_max_sockets: config.HTTP_MAX_SOCKETS,
        queue_entries: config.RESULT_QUEUE_MAX_ENTRIES,
        queue_bytes: config.RESULT_QUEUE_MAX_BYTES,
        batch_size: config.REPORT_BATCH_MAX_SIZE,
        batch_bytes: config.REPORT_BATCH_MAX_BYTES,
        soft_rss_bytes: config.SOFT_RSS_BYTES,
        hard_rss_bytes: config.HARD_RSS_BYTES,
    },
}, '[AGENT] Resource budgets selected');

const registry = createRegistry();
const api = new ApiClient(config.API_URL, config.PROBE_TOKEN, registry.capabilities());
const resultQueue = new ResultQueue(api, {
    maxEntries: config.RESULT_QUEUE_MAX_ENTRIES,
    maxBytes: config.RESULT_QUEUE_MAX_BYTES,
    maxBatchSize: config.REPORT_BATCH_MAX_SIZE,
    maxBatchBytes: config.REPORT_BATCH_MAX_BYTES,
});
const runtime = new AgentRuntime({
    config,
    logger,
    registry,
    api,
    resultQueue,
    version,
    budgets,
});

let terminating = false;

async function terminate(reason, exitCode) {
    if (terminating) return;
    terminating = true;
    try {
        await runtime.shutdown(reason);
    } finally {
        process.exit(exitCode);
    }
}

process.once('SIGTERM', () => void terminate('SIGTERM', 0));
process.once('SIGINT', () => void terminate('SIGINT', 0));
process.once('unhandledRejection', (reason) => {
    logger.fatal({
        name: reason?.name,
        code: reason?.code,
    }, '[FATAL] Unhandled promise rejection');
    void terminate('unhandledRejection', 1);
});
process.once('uncaughtException', (error) => {
    logger.fatal({
        name: error?.name,
        code: error?.code,
    }, '[FATAL] Uncaught exception');
    void terminate('uncaughtException', 1);
});

runtime.start().catch((error) => {
    logger.fatal({
        name: error?.name,
        code: error?.code,
        status: error?.response?.status,
    }, '[FATAL] Agent runtime stopped');
    void terminate('runtime_error', 1);
});
