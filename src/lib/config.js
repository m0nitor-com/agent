import { cleanEnv, str, num, url, bool } from 'envalid';
import 'dotenv/config';
import {
    DEFAULT_HEALTH_PORT,
    DEFAULT_HTTP_MAX_FREE_SOCKETS,
    DEFAULT_HTTP_MAX_SOCKETS,
    GOVERNOR_HARD_RSS_BYTES,
    GOVERNOR_SOFT_RSS_BYTES,
    MAX_REPORT_BATCH_BYTES,
    MAX_REPORT_BATCH_SIZE,
    REPORT_COALESCE_IDLE_MS,
    REPORT_MAX_IN_FLIGHT,
    RESULT_QUEUE_MAX_BYTES,
    RESULT_QUEUE_MAX_SIZE,
    SHUTDOWN_FLUSH_TIMEOUT_MS,
} from './constants.js';
import { computeBudgets, normalizeBudgets } from './budgets.js';
import { detectResources } from './resource-detect.js';

const detectedResources = detectResources();
const envSku = process.env.AGENT_SKU && String(process.env.AGENT_SKU).trim();
const detectedBudgets = computeBudgets(detectedResources, {
    sku: envSku || undefined,
});

const raw = cleanEnv(process.env, {
    API_URL: url({ desc: 'The URL of the m0nitor API' }),
    PROBE_TOKEN: str({ desc: 'The authentication token for this agent' }),
    LOG_LEVEL: str({ default: 'info', choices: ['debug', 'info', 'warn', 'error'] }),
    POLL_INTERVAL: num({ default: 5000, desc: 'Polling interval in milliseconds' }),
    POLL_MAX_INTERVAL: num({ default: 300_000, desc: 'Max poll interval (ms) under exponential backoff during consecutive failures' }),
    SKIP_SSL_VERIFY: bool({ default: false, desc: 'Skip SSL certificate verification (INSECURE - only for development)' }),
    ALLOW_PRIVATE_TARGETS: bool({ default: false, desc: 'INSECURE - allow monitors to target private/reserved IPs. Only for self-hosted operators monitoring trusted LAN.' }),
    IP_FAMILY: str({ default: 'auto', choices: ['auto', 'ipv4', 'ipv6'], desc: 'Default address family for checks when the monitor does not specify one. auto = let the OS choose.' }),
    HEALTH_PORT: num({ default: DEFAULT_HEALTH_PORT, desc: 'Port for the health check HTTP server' }),
    AGENT_SKU: str({ default: '', desc: 'Optional forced SKU profile: sku-1c1g, sku-2c2g, sku-2c4g' }),
    CONCURRENCY_LIMIT: num({ default: detectedBudgets.total, desc: 'Max active checks across all budgets' }),
    NETWORK_CONCURRENCY: num({ default: detectedBudgets.network, desc: 'Max active lightweight network checks' }),
    DATABASE_CONCURRENCY: num({ default: detectedBudgets.database, desc: 'Max active database checks' }),
    DIAGNOSTIC_CONCURRENCY: num({ default: detectedBudgets.diagnostic, desc: 'Max active diagnostic jobs' }),
    HTTP_MAX_SOCKETS: num({ default: detectedBudgets.httpMaxSockets || DEFAULT_HTTP_MAX_SOCKETS, desc: 'Max sockets per shared HTTP check agent' }),
    HTTP_MAX_FREE_SOCKETS: num({ default: detectedBudgets.httpMaxFreeSockets || DEFAULT_HTTP_MAX_FREE_SOCKETS, desc: 'Max free sockets retained per shared HTTP check agent' }),
    RESULT_QUEUE_MAX_ENTRIES: num({ default: detectedBudgets.queueEntries || RESULT_QUEUE_MAX_SIZE, desc: 'Maximum retry queue entries' }),
    RESULT_QUEUE_MAX_BYTES: num({ default: detectedBudgets.queueBytes || RESULT_QUEUE_MAX_BYTES, desc: 'Maximum serialized bytes retained for report retries' }),
    REPORT_BATCH_MAX_SIZE: num({ default: detectedBudgets.batchSize || MAX_REPORT_BATCH_SIZE, desc: 'Maximum results per report batch' }),
    REPORT_BATCH_MAX_BYTES: num({ default: detectedBudgets.batchBytes || MAX_REPORT_BATCH_BYTES, desc: 'Maximum serialized report request size' }),
    REPORT_COALESCE_IDLE_MS: num({ default: REPORT_COALESCE_IDLE_MS, desc: 'Idle flush delay for micro-batched reports' }),
    REPORT_MAX_IN_FLIGHT: num({ default: REPORT_MAX_IN_FLIGHT, desc: 'Max concurrent report-batch HTTP requests' }),
    SOFT_RSS_BYTES: num({ default: detectedBudgets.softRssBytes || GOVERNOR_SOFT_RSS_BYTES, desc: 'RSS soft limit that reduces effective concurrency' }),
    HARD_RSS_BYTES: num({ default: detectedBudgets.hardRssBytes || GOVERNOR_HARD_RSS_BYTES, desc: 'RSS hard limit that pauses the scheduler' }),
    SHUTDOWN_FLUSH_TIMEOUT: num({ default: SHUTDOWN_FLUSH_TIMEOUT_MS, desc: 'Maximum graceful result flush duration in milliseconds' }),
});

const normalized = normalizeBudgets({
    total: raw.CONCURRENCY_LIMIT,
    network: raw.NETWORK_CONCURRENCY,
    database: raw.DATABASE_CONCURRENCY,
    diagnostic: raw.DIAGNOSTIC_CONCURRENCY,
    httpMaxSockets: raw.HTTP_MAX_SOCKETS,
    httpMaxFreeSockets: raw.HTTP_MAX_FREE_SOCKETS,
    queueEntries: raw.RESULT_QUEUE_MAX_ENTRIES,
    queueBytes: raw.RESULT_QUEUE_MAX_BYTES,
    batchSize: raw.REPORT_BATCH_MAX_SIZE,
    batchBytes: raw.REPORT_BATCH_MAX_BYTES,
    softRssBytes: raw.SOFT_RSS_BYTES,
    hardRssBytes: raw.HARD_RSS_BYTES,
});

export const resources = detectedResources;
export const budgets = {
    ...detectedBudgets,
    ...normalized,
};

export const config = {
    ...raw,
    CONCURRENCY_LIMIT: normalized.total,
    NETWORK_CONCURRENCY: normalized.network,
    DATABASE_CONCURRENCY: normalized.database,
    DIAGNOSTIC_CONCURRENCY: normalized.diagnostic,
    HTTP_MAX_SOCKETS: normalized.httpMaxSockets,
    HTTP_MAX_FREE_SOCKETS: normalized.httpMaxFreeSockets,
    RESULT_QUEUE_MAX_ENTRIES: normalized.queueEntries,
    RESULT_QUEUE_MAX_BYTES: normalized.queueBytes,
    REPORT_BATCH_MAX_SIZE: normalized.batchSize,
    REPORT_BATCH_MAX_BYTES: normalized.batchBytes,
    SOFT_RSS_BYTES: normalized.softRssBytes,
    HARD_RSS_BYTES: Math.max(normalized.hardRssBytes, normalized.softRssBytes + 1),
};
