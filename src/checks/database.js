import { performance } from 'node:perf_hooks';
import { resolveAndCheck, familyLabel } from '../lib/ssrf.js';

const DATABASE_TYPES = new Set(['mysql', 'postgresql', 'redis']);
const MAX_QUERY_LENGTH = 4096;
const MAX_QUERY_ROWS = 100;
const MAX_QUERY_BYTES = 64 * 1024;
const MAX_METRICS_BYTES = 64 * 1024;
const MAX_CA_BYTES = 32 * 1024;
const MUTATING_SQL = /\b(?:insert|update|delete|replace|merge|upsert|alter|create|drop|truncate|grant|revoke|call|execute|copy|load|lock|unlock|set|reset|vacuum|analyze|refresh|reindex|cluster|do)\b/i;
const FORBIDDEN_READ_SQL = /\b(?:into|outfile|dumpfile|returning)\b|\bfor\s+(?:update|share)\b|\block\s+in\s+share\s+mode\b/i;
const SQL_COMMENT = /--|\/\*|\*\/|#/;

function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
}

export function validateReadOnlyQuery(query) {
    if (typeof query !== 'string') return null;
    if (query.length > MAX_QUERY_LENGTH) return null;
    let normalized = query.trim();
    if (normalized.length === 0) return null;
    if (SQL_COMMENT.test(normalized)) return null;
    if (normalized.endsWith(';')) normalized = normalized.slice(0, -1).trim();
    if (normalized.includes(';')) return null;
    if (!/^(?:select|with)\b/i.test(normalized)) return null;
    if (MUTATING_SQL.test(normalized)) return null;
    if (FORBIDDEN_READ_SQL.test(normalized)) return null;
    return normalized;
}

function normalizeTls(raw) {
    const tls = raw && typeof raw === 'object' ? raw : {};
    const ca = typeof tls.ca === 'string' && Buffer.byteLength(tls.ca) <= MAX_CA_BYTES
        ? tls.ca
        : null;
    return {
        enabled: tls.enabled === true,
        verify_server_certificate: tls.verify_server_certificate !== false,
        ca,
        server_name: typeof tls.server_name === 'string'
            ? tls.server_name.slice(0, 255)
            : null,
    };
}

export function validateDatabaseMonitor(raw) {
    if (!raw || typeof raw !== 'object' || raw.id == null) return null;
    const type = String(raw.type || '').toLowerCase();
    if (!DATABASE_TYPES.has(type)) return null;
    const database = raw.database_config;
    if (!database || typeof database !== 'object') return null;
    if (typeof database.host !== 'string' || database.host.trim() === '' || database.host.length > 255) return null;
    if (typeof database.password !== 'string' || database.password.length > 4096) return null;
    if (type !== 'redis' && (typeof database.username !== 'string' || database.username.length > 255)) return null;

    const defaultPort = type === 'mysql' ? 3306 : type === 'postgresql' ? 5432 : 6379;
    const query = validateReadOnlyQuery(database.query);
    const queryRequested = typeof database.query === 'string' && database.query.trim() !== '';
    if (queryRequested && (!query || raw.private_probe !== true)) return null;

    return {
        ...raw,
        type,
        url: database.host.trim(),
        timeout: boundedInteger(raw.timeout, 15, 2, 60),
        family: raw.family === 'ipv6' ? 'ipv6' : 'ipv4',
        database_config: {
            host: database.host.trim(),
            port: boundedInteger(database.port, defaultPort, 1, 65535),
            database: typeof database.database === 'string' ? database.database.slice(0, 255) : '',
            username: typeof database.username === 'string' ? database.username.slice(0, 255) : '',
            password: database.password,
            tls: normalizeTls(database.tls),
            query,
            collect_metrics: database.collect_metrics !== false,
            assertion: normalizeAssertion(database.assertion),
        },
    };
}

function normalizeAssertion(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const operators = ['equals', 'not_equals', 'contains', 'numeric_lte', 'numeric_gte'];
    if (!operators.includes(raw.operator)) return null;
    const value = typeof raw.value === 'string' || typeof raw.value === 'number'
        ? String(raw.value).slice(0, 512)
        : null;
    return value === null ? null : { operator: raw.operator, value };
}

function tlsOptions(tls, hostname) {
    if (!tls.enabled) return undefined;
    return {
        rejectUnauthorized: tls.verify_server_certificate,
        ...(tls.ca ? { ca: tls.ca } : {}),
        servername: tls.server_name || hostname,
    };
}

function safeScalar(value) {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'string') return value.slice(0, 512);
    return null;
}

function boundedObject(input, maxBytes = MAX_METRICS_BYTES) {
    const result = {};
    for (const [key, value] of Object.entries(input || {}).slice(0, 64)) {
        const scalar = safeScalar(value);
        if (scalar === undefined) continue;
        result[String(key).slice(0, 80)] = scalar;
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
            delete result[String(key).slice(0, 80)];
            break;
        }
    }
    return result;
}

function boundedQuerySummary(rows) {
    const selected = Array.isArray(rows) ? rows.slice(0, MAX_QUERY_ROWS) : [];
    let bytes = 0;
    const boundedRows = [];
    for (const row of selected) {
        const safeRow = boundedObject(row, Math.min(4096, MAX_QUERY_BYTES - bytes));
        const rowBytes = Buffer.byteLength(JSON.stringify(safeRow));
        if (bytes + rowBytes > MAX_QUERY_BYTES) break;
        bytes += rowBytes;
        boundedRows.push(safeRow);
    }
    return {
        row_count: Array.isArray(rows) ? Math.min(rows.length, MAX_QUERY_ROWS + 1) : 0,
        returned_rows: boundedRows.length,
        returned_bytes: bytes,
        truncated: Array.isArray(rows) && (rows.length > boundedRows.length),
        first_row: boundedRows[0] || null,
    };
}

function evaluateAssertion(assertion, summary) {
    if (!assertion) return { passed: true, detail: null };
    const firstValue = summary.first_row ? Object.values(summary.first_row)[0] : null;
    const actual = firstValue === null || firstValue === undefined ? '' : String(firstValue);
    const expected = assertion.value;
    const passed = {
        equals: actual === expected,
        not_equals: actual !== expected,
        contains: actual.includes(expected),
        numeric_lte: Number.isFinite(Number(actual)) && Number(actual) <= Number(expected),
        numeric_gte: Number.isFinite(Number(actual)) && Number(actual) >= Number(expected),
    }[assertion.operator] === true;
    return {
        passed,
        detail: {
            operator: assertion.operator,
            expected: expected.slice(0, 128),
            actual: actual.slice(0, 128),
        },
    };
}

function classifyDatabaseError(error) {
    const code = String(error?.code || error?.errno || '').slice(0, 60);
    if (['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'CONNECT_TIMEOUT'].includes(code)) return 'timeout';
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
    if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'connection';
    if (/AUTH|PASSWORD|ACCESS_DENIED|28P01|ER_ACCESS_DENIED_ERROR/i.test(code)) return 'authentication';
    if (/CERT|TLS|SSL/i.test(code)) return 'tls';
    return 'database_error';
}

async function runMysql(config, target, context) {
    const mysql = await import('mysql2');
    const rawConnection = mysql.createConnection({
        host: target,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database || undefined,
        connectTimeout: Math.min(context.remainingMs(), 10_000),
        ssl: tlsOptions(config.tls, config.host),
        enableKeepAlive: false,
        maxPreparedStatements: 4,
    });
    let destroyed = false;
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        rawConnection.destroy();
    };
    const unregisterCleanup = context.cleanup.add(destroy);
    const connection = rawConnection.promise();
    const connectStarted = performance.now();
    try {
        await connection.connect();
    } catch (error) {
        unregisterCleanup();
        destroy();
        throw Object.assign(error, { phase: 'connect' });
    }
    const connectMs = performance.now() - connectStarted;

    try {
        context.throwIfAborted();
        const operationStarted = performance.now();
        await connection.query({
            sql: 'SET SESSION TRANSACTION READ ONLY',
            timeout: context.remainingMs(),
        });
        await connection.query({ sql: 'SELECT 1 AS health', timeout: context.remainingMs() });
        let querySummary = null;
        if (config.query) {
            const boundedSql = `SELECT * FROM (${config.query}) AS m0nitor_query LIMIT ${MAX_QUERY_ROWS + 1}`;
            const [rows] = await connection.query({ sql: boundedSql, timeout: context.remainingMs() });
            querySummary = boundedQuerySummary(rows);
        }

        const metrics = {};
        const metricErrors = [];
        if (config.collect_metrics) {
            try {
                const [rows] = await connection.query({
                    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Slow_queries','Aborted_connects','Connections')",
                    timeout: context.remainingMs(),
                });
                for (const row of rows.slice(0, 16)) {
                    metrics[String(row.Variable_name).toLowerCase()] = safeScalar(row.Value);
                }
            } catch (error) {
                metricErrors.push(classifyDatabaseError(error));
            }
            try {
                const [rows] = await connection.query({ sql: 'SHOW REPLICA STATUS', timeout: context.remainingMs() });
                const replica = rows[0];
                if (replica) {
                    metrics.replication_role = 'replica';
                    metrics.replication_lag_seconds = safeScalar(replica.Seconds_Behind_Source);
                    metrics.replication_io_running = safeScalar(replica.Replica_IO_Running);
                    metrics.replication_sql_running = safeScalar(replica.Replica_SQL_Running);
                } else {
                    metrics.replication_role = 'primary';
                }
            } catch (error) {
                metricErrors.push(classifyDatabaseError(error));
            }
        }
        return {
            connect_ms: connectMs,
            operation_ms: performance.now() - operationStarted,
            metrics: boundedObject(metrics),
            metrics_partial: metricErrors.length > 0,
            metric_errors: [...new Set(metricErrors)].slice(0, 5),
            query: querySummary,
        };
    } finally {
        unregisterCleanup();
        destroy();
    }
}

async function runPostgresql(config, target, context) {
    const { Client } = await import('pg');
    const client = new Client({
        host: target,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database || undefined,
        connectionTimeoutMillis: Math.min(context.remainingMs(), 10_000),
        query_timeout: context.remainingMs(),
        statement_timeout: context.remainingMs(),
        ssl: tlsOptions(config.tls, config.host),
        application_name: 'm0nitor-agent',
    });
    const forceClose = () => client.connection?.stream?.destroy();
    const unregisterCleanup = context.cleanup.add(forceClose);
    const connectStarted = performance.now();
    try {
        await client.connect();
    } catch (error) {
        forceClose();
        throw Object.assign(error, { phase: 'connect' });
    }
    const connectMs = performance.now() - connectStarted;

    try {
        context.throwIfAborted();
        const operationStarted = performance.now();
        await client.query('SET default_transaction_read_only = on');
        await client.query('SELECT 1 AS health');
        let querySummary = null;
        if (config.query) {
            const boundedSql = `SELECT * FROM (${config.query}) AS m0nitor_query LIMIT ${MAX_QUERY_ROWS + 1}`;
            querySummary = boundedQuerySummary((await client.query(boundedSql)).rows);
        }
        const metrics = {};
        const metricErrors = [];
        if (config.collect_metrics) {
            try {
                const status = await client.query(`
                    SELECT
                        EXTRACT(EPOCH FROM (clock_timestamp() - pg_postmaster_start_time()))::bigint AS uptime_seconds,
                        (SELECT count(*) FROM pg_stat_activity) AS connections,
                        current_setting('max_connections')::int AS max_connections,
                        pg_is_in_recovery() AS in_recovery
                `);
                Object.assign(metrics, status.rows[0] || {});
            } catch (error) {
                metricErrors.push(classifyDatabaseError(error));
            }
            try {
                const blocked = await client.query(`
                    SELECT count(*)::int AS blocked_queries
                    FROM pg_stat_activity
                    WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
                `);
                Object.assign(metrics, blocked.rows[0] || {});
            } catch (error) {
                metricErrors.push(classifyDatabaseError(error));
            }
        }
        return {
            connect_ms: connectMs,
            operation_ms: performance.now() - operationStarted,
            metrics: boundedObject(metrics),
            metrics_partial: metricErrors.length > 0,
            metric_errors: [...new Set(metricErrors)].slice(0, 5),
            query: querySummary,
        };
    } finally {
        unregisterCleanup();
        let closeTimer;
        try {
            await Promise.race([
                client.end(),
                new Promise((resolve) => {
                    closeTimer = setTimeout(resolve, 250);
                    closeTimer.unref?.();
                }),
            ]);
        } finally {
            clearTimeout(closeTimer);
            forceClose();
        }
    }
}

function parseRedisInfo(text) {
    const metrics = {};
    if (typeof text !== 'string') return metrics;
    for (const line of text.slice(0, MAX_METRICS_BYTES).split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf(':');
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        const allowed = new Set([
            'uptime_in_seconds',
            'connected_clients',
            'blocked_clients',
            'used_memory',
            'maxmemory',
            'mem_fragmentation_ratio',
            'evicted_keys',
            'rejected_connections',
            'role',
            'connected_slaves',
            'master_link_status',
            'master_last_io_seconds_ago',
        ]);
        if (!allowed.has(key)) continue;
        const raw = line.slice(separator + 1).trim();
        metrics[key] = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw.slice(0, 128);
    }
    return metrics;
}

async function runRedis(config, target, context) {
    const { createClient } = await import('redis');
    const client = createClient({
        username: config.username || undefined,
        password: config.password || undefined,
        database: config.database ? boundedInteger(config.database, 0, 0, 15) : 0,
        socket: {
            host: target,
            port: config.port,
            connectTimeout: Math.min(context.remainingMs(), 10_000),
            tls: config.tls.enabled,
            rejectUnauthorized: config.tls.verify_server_certificate,
            ...(config.tls.ca ? { ca: config.tls.ca } : {}),
            ...(config.tls.server_name ? { servername: config.tls.server_name } : {}),
            reconnectStrategy: false,
        },
        commandsQueueMaxLength: 4,
        disableOfflineQueue: true,
    });
    const unregisterCleanup = context.cleanup.add(() => client.destroy());
    const connectStarted = performance.now();
    try {
        await client.connect();
    } catch (error) {
        client.destroy();
        throw Object.assign(error, { phase: 'connect' });
    }
    const connectMs = performance.now() - connectStarted;

    try {
        context.throwIfAborted();
        const operationStarted = performance.now();
        const pong = await client.ping();
        const metrics = {};
        const metricErrors = [];
        if (config.collect_metrics) {
            for (const section of ['server', 'clients', 'memory', 'stats', 'replication']) {
                try {
                    Object.assign(metrics, parseRedisInfo(await client.info(section)));
                } catch (error) {
                    metricErrors.push(classifyDatabaseError(error));
                }
            }
        }
        return {
            connect_ms: connectMs,
            operation_ms: performance.now() - operationStarted,
            metrics: boundedObject({ ping: pong, ...metrics }),
            metrics_partial: metricErrors.length > 0,
            metric_errors: [...new Set(metricErrors)].slice(0, 5),
            query: null,
        };
    } finally {
        unregisterCleanup();
        client.destroy();
    }
}

export async function checkDatabase(monitor, context) {
    const started = performance.now();
    const config = monitor.database_config;
    const allowPrivate = monitor.private_probe === true
        && monitor.allow_private_target === true;
    const resolved = await resolveAndCheck(config.host, {
        family: monitor.family,
        allowPrivate,
        signal: context.signal,
    });
    if (!resolved.ok) {
        return {
            monitor_id: monitor.id,
            is_success: false,
            response_time_ms: Math.round(performance.now() - started),
            family: monitor.family,
            error_type: resolved.reason === 'blocked_private_target' ? 'blocked_private_target' : 'dns',
            error_message: resolved.reason === 'blocked_private_target'
                ? 'Database target is private or reserved and this probe is not authorized'
                : 'Database target could not be resolved',
        };
    }

    try {
        const details = monitor.type === 'mysql'
            ? await runMysql(config, resolved.ip, context)
            : monitor.type === 'postgresql'
                ? await runPostgresql(config, resolved.ip, context)
                : await runRedis(config, resolved.ip, context);
        const assertion = evaluateAssertion(config.assertion, details.query || {
            first_row: { health: 1 },
        });
        const queryTelemetry = details.query ? {
            row_count: details.query.row_count,
            returned_rows: details.query.returned_rows,
            returned_bytes: details.query.returned_bytes,
            truncated: details.query.truncated,
        } : null;
        const totalMs = performance.now() - started;
        return {
            monitor_id: monitor.id,
            is_success: assertion.passed,
            response_time_ms: Math.round(totalMs),
            resolved_ip: resolved.ip,
            family: familyLabel(resolved.family),
            error_type: assertion.passed ? null : 'assertion',
            error_message: assertion.passed ? null : 'Database assertion failed',
            metrics: {
                engine: monitor.type,
                connect_time_ms: Number(details.connect_ms.toFixed(3)),
                operation_time_ms: Number(details.operation_ms.toFixed(3)),
                total_time_ms: Number(totalMs.toFixed(3)),
                values: details.metrics,
                metrics_partial: details.metrics_partial,
                metric_errors: details.metric_errors,
                query: queryTelemetry,
                assertion: assertion.detail,
            },
        };
    } catch (error) {
        const type = classifyDatabaseError(error);
        return {
            monitor_id: monitor.id,
            is_success: false,
            response_time_ms: Math.round(performance.now() - started),
            resolved_ip: resolved.ip,
            family: familyLabel(resolved.family),
            error_type: type,
            error_message: {
                timeout: 'Database operation timed out',
                dns: 'Database target could not be resolved',
                connection: 'Database connection failed',
                authentication: 'Database authentication failed',
                tls: 'Database TLS negotiation failed',
                database_error: 'Database health operation failed',
            }[type],
        };
    }
}

export default checkDatabase;
