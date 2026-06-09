import { logger } from './logger.js';
import {
    DEFAULT_MONITOR_TIMEOUT_S,
    MAX_MONITOR_TIMEOUT_S,
    MIN_MONITOR_TIMEOUT_S,
    DEFAULT_SSL_MIN_DAYS,
} from './constants.js';

/**
 * Validate and normalize a monitor object from the API.
 * Returns a sanitized monitor with safe defaults, or null if fundamentally invalid.
 */
export function validateMonitor(raw) {
    if (!raw || typeof raw !== 'object') {
        logger.warn('[VALIDATOR] Received non-object monitor, skipping');
        return null;
    }

    // id is required
    if (raw.id == null) {
        logger.warn('[VALIDATOR] Monitor missing id, skipping');
        return null;
    }

    // type is required
    const validTypes = ['http', 'https', 'ping', 'tcp', 'ssh', 'udp', 'dns'];
    const type = String(raw.type || '').toLowerCase();
    if (!validTypes.includes(type)) {
        logger.warn({ monitor_id: raw.id, type: raw.type }, '[VALIDATOR] Unknown monitor type');
        // Still return it — executeCheck handles unknown types gracefully
    }

    // url is required for all types
    if (!raw.url || typeof raw.url !== 'string' || raw.url.trim() === '') {
        logger.warn({ monitor_id: raw.id }, '[VALIDATOR] Monitor missing url, skipping');
        return null;
    }

    // Scheme validation: only http(s) for http/https monitors. Other types accept
    // bare hostnames (tcp/udp/ping/dns/ssh), so we skip URL parsing for them.
    if (type === 'http' || type === 'https') {
        try {
            const u = new URL(raw.url);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                logger.warn({ monitor_id: raw.id, scheme: u.protocol }, '[VALIDATOR] Rejected non-http(s) scheme');
                return null;
            }
        } catch {
            logger.warn({ monitor_id: raw.id, url: raw.url }, '[VALIDATOR] Malformed URL for http monitor');
            return null;
        }
    }

    // Clamp timeout
    let timeout = Number(raw.timeout);
    if (!Number.isFinite(timeout) || timeout < MIN_MONITOR_TIMEOUT_S) {
        timeout = DEFAULT_MONITOR_TIMEOUT_S;
    } else if (timeout > MAX_MONITOR_TIMEOUT_S) {
        logger.debug({ monitor_id: raw.id, original: raw.timeout, clamped: MAX_MONITOR_TIMEOUT_S },
            '[VALIDATOR] Timeout clamped to maximum');
        timeout = MAX_MONITOR_TIMEOUT_S;
    }

    // Normalize success_criteria
    const criteria = (raw.success_criteria && typeof raw.success_criteria === 'object')
        ? { ...raw.success_criteria }
        : {};

    // Normalize ssl_min_days
    let sslMinDays = Number(criteria.ssl_min_days);
    if (!Number.isFinite(sslMinDays) || sslMinDays < 0) {
        sslMinDays = DEFAULT_SSL_MIN_DAYS;
    }
    criteria.ssl_min_days = sslMinDays;

    // Normalize status_codes
    if (criteria.status_codes != null) {
        if (!Array.isArray(criteria.status_codes)) {
            criteria.status_codes = [];
        } else {
            criteria.status_codes = criteria.status_codes
                .map(c => Number(c))
                .filter(c => Number.isFinite(c) && c >= 100 && c < 600);
        }
    }

    // Normalize keywords
    if (criteria.keywords != null && !Array.isArray(criteria.keywords)) {
        criteria.keywords = [];
    }

    // Normalize header_assertions
    const validHeaderComparisons = ['contains', 'not_contains', 'eq', 'not_eq', 'empty', 'not_empty'];
    if (criteria.header_assertions != null) {
        if (!Array.isArray(criteria.header_assertions)) {
            criteria.header_assertions = [];
        } else {
            criteria.header_assertions = criteria.header_assertions.filter(
                (a) => a && typeof a === 'object'
                    && typeof a.header === 'string'
                    && validHeaderComparisons.includes(a.comparison)
                    && typeof a.value === 'string'
            );
        }
    }

    return {
        ...raw,
        type,
        timeout,
        success_criteria: criteria,
        // Preserve other fields (headers, body, method, etc.) as-is
    };
}
