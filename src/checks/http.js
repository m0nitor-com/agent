import axios from 'axios';
import https from 'https';
import http from 'http';
import tls from 'tls';
import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { logger } from '../lib/logger.js';
import { config as appConfig } from '../lib/config.js';
import { resolveAndCheck, isPrivateIp } from '../lib/ssrf.js';
import {
    MAX_RESPONSE_BODY_LENGTH,
    MAX_REQUEST_BODY_LENGTH,
    MAX_HEADER_VALUE_LENGTH,
    RESPONSE_BODY_PREVIEW_LENGTH,
    MAX_REDIRECTS,
    DEFAULT_HTTP_METHOD,
    DEFAULT_ACCEPTED_STATUS_CODES,
    DEFAULT_SSL_MIN_DAYS,
    DEFAULT_MAX_RESPONSE_TIME_MS,
    TLS_HANDSHAKE_TIMEOUT_MS,
    MIN_MONITOR_TIMEOUT_S,
    MAX_MONITOR_TIMEOUT_S,
    DEFAULT_MONITOR_TIMEOUT_S,
} from '../lib/constants.js';

/**
 * Essential response headers worth keeping for diagnostics.
 */
const ESSENTIAL_HEADERS = new Set([
    'content-type',
    'content-length',
    'server',
    'x-powered-by',
    'cache-control',
    'location',
    'x-frame-options',
    'strict-transport-security',
    'content-encoding',
    'x-content-type-options',
    'x-request-id',
    'retry-after',
]);

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Patterns for sensitive data that should be redacted in response body previews.
 */
const SENSITIVE_PATTERNS = [
    /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|credential)["\s]*[:=]["\s]*["']?[a-zA-Z0-9_\-./+=]{8,}["']?/gi,
    /(?:Bearer|Basic)\s+[a-zA-Z0-9_\-./+=]{20,}/gi,
    /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWT tokens
];

/**
 * Filter response headers to only essential ones (O(1) lookup with Set).
 */
function filterHeaders(headers) {
    if (!headers) return null;
    const filtered = {};
    for (const [key, value] of Object.entries(headers)) {
        if (ESSENTIAL_HEADERS.has(key.toLowerCase())) {
            filtered[key] = value;
        }
    }
    return Object.keys(filtered).length > 0 ? filtered : null;
}

/**
 * Sanitize response body preview by redacting potential sensitive data.
 */
function sanitizeBodyPreview(body) {
    if (!body || typeof body !== 'string') return body;
    let sanitized = body;
    for (const pattern of SENSITIVE_PATTERNS) {
        sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
    return sanitized;
}

/**
 * Check if a string looks like valid JSON.
 */
function isJsonLike(str) {
    if (typeof str !== 'string') return false;
    const trimmed = str.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function hasHeaderCaseInsensitive(headers, needle) {
    const target = needle.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function toHeaderValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    try {
        return JSON.stringify(value);
    } catch {
        return '';
    }
}

function setHeader(normalized, key, value) {
    const headerName = String(key || '').trim();
    if (!headerName || !HEADER_NAME_PATTERN.test(headerName)) return;
    const headerValue = toHeaderValue(value);
    if (headerValue.length > MAX_HEADER_VALUE_LENGTH) return;
    normalized[headerName] = headerValue;
}

/**
 * Normalize headers so both object and [{key,value}] inputs are supported.
 */
function normalizeRequestHeaders(rawHeaders) {
    const normalized = {};

    if (!rawHeaders || typeof rawHeaders !== 'object') {
        return normalized;
    }

    if (Array.isArray(rawHeaders)) {
        for (const row of rawHeaders) {
            if (!row || typeof row !== 'object') continue;
            setHeader(normalized, row.key, row.value);
        }
        return normalized;
    }

    for (const [key, value] of Object.entries(rawHeaders)) {
        if (/^\d+$/.test(key) && value && typeof value === 'object' && 'key' in value) {
            setHeader(normalized, value.key, value.value);
            continue;
        }
        setHeader(normalized, key, value);
    }

    return normalized;
}

/**
 * Fetch SSL certificate for a given hostname, used as fallback when the
 * original connection cert is unavailable (e.g. after cross-host redirects).
 */
function fetchCertificate(hostname, port = 443) {
    return new Promise((resolve, reject) => {
        const tlsSocket = tls.connect(
            { host: hostname, port, servername: hostname, timeout: TLS_HANDSHAKE_TIMEOUT_MS },
            () => {
                const peerCert = tlsSocket.getPeerCertificate();
                tlsSocket.destroy();
                resolve(peerCert);
            }
        );
        tlsSocket.on('error', (err) => { tlsSocket.destroy(); reject(err); });
        tlsSocket.setTimeout(TLS_HANDSHAKE_TIMEOUT_MS, () => { tlsSocket.destroy(); reject(new Error('TLS handshake timeout')); });
    });
}

/**
 * Perform HTTP/HTTPS check on a monitor
 */
export async function checkHttp(monitor) {
    const startTime = Date.now();
    const result = {
        monitor_id: monitor.id,
        is_success: false,
        response_time_ms: null,
        status_code: null,
        error_message: null,
        error_type: null,
        response_headers: null,
        response_body_preview: null,
        ssl_info: null,
    };

    // SSRF mitigation: block requests targeting private/reserved IPs unless the
    // monitor or the worker is explicitly opted into private targets.
    const allowPrivate = monitor.allow_private_target === true || appConfig.ALLOW_PRIVATE_TARGETS === true;

    // Guarded DNS lookup used by the http/https agents to prevent connecting to
    // private addresses (handles cases where DNS rebinding could trick us between
    // the pre-flight check and the actual socket connection).
    const guardedLookup = (hostname, options, cb) => {
        dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
            if (err) return cb(err);
            const list = Array.isArray(addrs) ? addrs : [addrs];
            for (const a of list) {
                if (isPrivateIp(a.address)) {
                    const blockErr = new Error(`blocked_private_target:${a.address}`);
                    blockErr.code = 'EBLOCKED';
                    return cb(blockErr);
                }
            }
            if (options && options.all) return cb(null, list);
            return cb(null, list[0].address, list[0].family);
        });
    };

    try {
        // Build request headers with sensible defaults
        const headers = normalizeRequestHeaders(monitor.headers);

        if (!hasHeaderCaseInsensitive(headers, 'User-Agent')) {
            headers['User-Agent'] = 'm0nitor/1.0';
        }
        if (!hasHeaderCaseInsensitive(headers, 'Accept')) {
            headers['Accept'] = '*/*';
        }

        const rawMethod = String(monitor.method || DEFAULT_HTTP_METHOD).toUpperCase();
        const method = HTTP_METHODS.includes(rawMethod) ? rawMethod : DEFAULT_HTTP_METHOD;
        if (method !== rawMethod) {
            logger.warn({ monitor_id: monitor.id, raw_method: rawMethod }, '[HTTP] Invalid method from API, falling back to GET');
        }
        if (monitor.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
            if (!hasHeaderCaseInsensitive(headers, 'Content-Type')) {
                headers['Content-Type'] = isJsonLike(monitor.body)
                    ? 'application/json'
                    : 'text/plain';
            }
        }

        const isHttps = monitor.url?.startsWith('https://');
        const timeoutSeconds = Math.min(
            Math.max(MIN_MONITOR_TIMEOUT_S, Number.isFinite(Number(monitor.timeout)) ? Number(monitor.timeout) : DEFAULT_MONITOR_TIMEOUT_S),
            MAX_MONITOR_TIMEOUT_S
        );
        const followRedirects = monitor.follow_redirects !== false;

        logger.debug({
            monitor_id: monitor.id,
            method,
            header_keys: Object.keys(headers),
            follow_redirects: followRedirects,
        }, '[HTTP] Prepared request');

        // Build request config
        const requestConfig = {
            method,
            url: monitor.url,
            timeout: timeoutSeconds * 1000,
            headers,
            maxRedirects: followRedirects ? MAX_REDIRECTS : 0,
            maxContentLength: MAX_RESPONSE_BODY_LENGTH,
            maxBodyLength: MAX_REQUEST_BODY_LENGTH,
            validateStatus: () => true,
        };

        const sslCheck = monitor.success_criteria?.ssl_check !== false;
        if (!allowPrivate) {
            // Build agents that BOTH enforce the guarded lookup (axios may
            // redirect across http <-> https, so we attach both).
            requestConfig.httpAgent = new http.Agent({ lookup: guardedLookup });
            requestConfig.httpsAgent = new https.Agent({
                rejectUnauthorized: sslCheck && !appConfig.SKIP_SSL_VERIFY,
                lookup: guardedLookup,
            });
        } else if (isHttps) {
            requestConfig.httpsAgent = new https.Agent({
                rejectUnauthorized: sslCheck && !appConfig.SKIP_SSL_VERIFY,
            });
        } else {
            requestConfig.httpAgent = new http.Agent();
        }

        if (!allowPrivate) {
            requestConfig.beforeRedirect = (options) => {
                const href = options.href || (options.protocol && options.hostname
                    ? `${options.protocol}//${options.hostname}${options.path || ''}`
                    : null);
                if (!href) return;
                let next;
                try { next = new URL(href); } catch { throw new Error('blocked_redirect_invalid'); }
                if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                    throw new Error('blocked_redirect_scheme');
                }
                if (ipaddr.isValid(next.hostname) && isPrivateIp(next.hostname)) {
                    throw new Error('blocked_private_target');
                }
            };
        }

        if (monitor.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
            requestConfig.data = monitor.body;
        }

        // Pre-flight SSRF check on the initial URL before any socket work.
        if (!allowPrivate) {
            let urlObj;
            try { urlObj = new URL(monitor.url); }
            catch {
                result.error_type = 'validation';
                result.error_message = 'Malformed monitor URL';
                return result;
            }
            const check = await resolveAndCheck(urlObj.hostname);
            if (!check.ok && check.reason === 'blocked_private_target') {
                result.response_time_ms = Date.now() - startTime;
                result.error_type = 'blocked_private_target';
                result.error_message = `Target ${urlObj.hostname} resolves to a private/reserved IP (${check.ip})`;
                logger.warn({ monitor_id: monitor.id, hostname: urlObj.hostname, ip: check.ip }, '[HTTP] Blocked private target');
                return result;
            }
            // Note: dns_failure passes through; the actual request will surface ENOTFOUND/EAI_AGAIN normally
        }

        // Make the request
        const response = await axios(requestConfig);

        result.response_time_ms = Date.now() - startTime;
        result.status_code = response.status;

        // Filter response headers
        const filteredHeaders = filterHeaders(response.headers);

        // Track final URL after redirects
        const finalUrl = response.request?.res?.responseUrl || response.config?.url;
        if (finalUrl && finalUrl !== monitor.url) {
            if (!filteredHeaders) {
                result.response_headers = { _final_url: finalUrl };
            } else {
                filteredHeaders._final_url = finalUrl;
                result.response_headers = filteredHeaders;
            }
        } else {
            result.response_headers = filteredHeaders;
        }

        // Get response body preview (sanitized)
        let rawPreview = '';
        if (typeof response.data === 'string') {
            rawPreview = response.data.substring(0, RESPONSE_BODY_PREVIEW_LENGTH);
        } else if (typeof response.data === 'object') {
            rawPreview = JSON.stringify(response.data).substring(0, RESPONSE_BODY_PREVIEW_LENGTH);
        }
        result.response_body_preview = sanitizeBodyPreview(rawPreview);

        // Check success criteria
        const criteria = monitor.success_criteria || {};
        const acceptedCodes = Array.isArray(criteria.status_codes)
            ? criteria.status_codes.map((code) => Number(code)).filter((code) => Number.isFinite(code))
            : [];
        const resolvedAcceptedCodes = acceptedCodes.length > 0 ? acceptedCodes : DEFAULT_ACCEPTED_STATUS_CODES;
        const maxResponseTime = Number.isFinite(Number(criteria.max_response_time))
            ? Number(criteria.max_response_time)
            : DEFAULT_MAX_RESPONSE_TIME_MS;

        if (!resolvedAcceptedCodes.includes(response.status)) {
            result.is_success = false;
            result.error_type = 'status_code';
            result.error_message = `Expected status ${resolvedAcceptedCodes.join('/')}, got ${response.status}`;
            return result;
        }

        if (result.response_time_ms > maxResponseTime) {
            result.is_success = false;
            result.error_type = 'response_time';
            result.error_message = `Response time ${result.response_time_ms}ms exceeds limit ${maxResponseTime}ms`;
            return result;
        }

        // Check keywords
        if (criteria.keywords && criteria.keywords.length > 0) {
            let fullBody = '';
            if (typeof response.data === 'string') {
                fullBody = response.data;
            } else if (typeof response.data === 'object') {
                fullBody = JSON.stringify(response.data);
            }
            for (const keyword of criteria.keywords) {
                if (!fullBody.includes(keyword)) {
                    result.is_success = false;
                    result.error_type = 'keyword';
                    result.error_message = `Keyword "${keyword}" not found in response`;
                    return result;
                }
            }
        }

        // Check header assertions
        if (Array.isArray(criteria.header_assertions) && criteria.header_assertions.length > 0) {
            for (const assertion of criteria.header_assertions) {
                const headerName = assertion.header.toLowerCase();
                const actualValue = response.headers[headerName] || '';
                const expectedValue = assertion.value || '';
                const comparison = assertion.comparison;
                let passed = true;

                switch (comparison) {
                    case 'contains':
                        passed = actualValue.toLowerCase().includes(expectedValue.toLowerCase());
                        break;
                    case 'not_contains':
                        passed = !actualValue.toLowerCase().includes(expectedValue.toLowerCase());
                        break;
                    case 'eq':
                        passed = actualValue.toLowerCase() === expectedValue.toLowerCase();
                        break;
                    case 'not_eq':
                        passed = actualValue.toLowerCase() !== expectedValue.toLowerCase();
                        break;
                    case 'empty':
                        passed = !response.headers[headerName] || response.headers[headerName] === '';
                        break;
                    case 'not_empty':
                        passed = !!response.headers[headerName] && response.headers[headerName] !== '';
                        break;
                    default:
                        passed = false;
                }

                if (!passed) {
                    result.is_success = false;
                    result.error_type = 'header';
                    result.error_message = `Header assertion failed: "${assertion.header}" ${comparison} "${expectedValue}" (actual: "${actualValue}")`;
                    return result;
                }
            }
        }

        // SSL check for HTTPS monitors
        if (monitor.type === 'https' && criteria.ssl_check !== false) {
            try {
                let cert = null;

                // Try to get cert from the existing axios response socket
                const socket = response.request?.socket || response.request?.res?.socket;
                if (socket && typeof socket.getPeerCertificate === 'function') {
                    cert = socket.getPeerCertificate(true);
                }

                // Determine if we redirected to a different host
                let certHostname = new URL(monitor.url).hostname;
                if (finalUrl && finalUrl !== monitor.url) {
                    try {
                        const finalHostname = new URL(finalUrl).hostname;
                        if (finalHostname !== certHostname) {
                            // Redirected to different host — must fetch cert for the final host
                            logger.debug({ monitor_id: monitor.id, from: certHostname, to: finalHostname },
                                '[HTTP] Redirect changed host, fetching SSL cert for final host');
                            certHostname = finalHostname;
                            cert = null; // Force re-fetch for correct host
                        }
                    } catch { /* ignore URL parse errors */ }
                }

                // Fallback: raw TLS connect (only if socket cert unavailable)
                if (!cert || !cert.valid_to) {
                    const urlObj = new URL(finalUrl || monitor.url);
                    if (!allowPrivate) {
                        const tlsCheck = await resolveAndCheck(urlObj.hostname);
                        if (!tlsCheck.ok && tlsCheck.reason === 'blocked_private_target') {
                            logger.warn({ monitor_id: monitor.id, hostname: urlObj.hostname }, '[HTTP] Skipping TLS fallback for private host');
                            // Skip fetchCertificate; cert info remains absent.
                        } else {
                            cert = await fetchCertificate(urlObj.hostname, parseInt(urlObj.port) || 443);
                        }
                    } else {
                        cert = await fetchCertificate(urlObj.hostname, parseInt(urlObj.port) || 443);
                    }
                }

                if (cert && cert.valid_to) {
                    const validTo = new Date(cert.valid_to);
                    const validFrom = new Date(cert.valid_from);
                    const now = new Date();
                    const daysRemaining = Math.floor((validTo - now) / (1000 * 60 * 60 * 24));
                    const isValid = now >= validFrom && now <= validTo;

                    result.ssl_info = {
                        valid: isValid,
                        days_remaining: daysRemaining,
                        issuer: cert.issuer?.O || cert.issuer?.CN || 'Unknown',
                        valid_from: cert.valid_from,
                        valid_to: cert.valid_to,
                    };

                    const minDays = criteria.ssl_min_days || DEFAULT_SSL_MIN_DAYS;
                    if (!isValid) {
                        result.is_success = false;
                        result.error_type = 'ssl';
                        result.error_message = 'SSL certificate is invalid';
                        return result;
                    }

                    if (daysRemaining < minDays) {
                        result.is_success = false;
                        result.error_type = 'ssl';
                        result.error_message = `SSL certificate expires in ${daysRemaining} days (min: ${minDays})`;
                        return result;
                    }
                }
            } catch (sslError) {
                logger.warn({ err: sslError }, '[HTTP] SSL check failed');
                result.ssl_info = { error: sslError.message };
            }
        }

        result.is_success = true;

    } catch (error) {
        result.response_time_ms = Date.now() - startTime;

        const code = error.code || '';
        const message = error.message || '';

        if (code === 'EBLOCKED' || message.includes('blocked_private_target') || message.includes('blocked_redirect')) {
            result.error_type = 'blocked_private_target';
            result.error_message = message.includes('blocked_redirect_scheme')
                ? 'Redirect target uses a disallowed scheme'
                : 'Target resolves to a private/reserved IP address';
        } else if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT') {
            result.error_type = 'timeout';
            result.error_message = `Connection timed out after ${monitor.timeout || DEFAULT_MONITOR_TIMEOUT_S}s`;
        } else if (code === 'ENOTFOUND') {
            result.error_type = 'dns';
            result.error_message = `DNS resolution failed for ${monitor.url}`;
        } else if (code === 'EAI_AGAIN') {
            result.error_type = 'dns_temporary';
            result.error_message = `Temporary DNS failure for ${monitor.url} (try again later)`;
        } else if (code === 'ECONNREFUSED') {
            result.error_type = 'connection';
            result.error_message = 'Connection refused';
        } else if (code === 'ECONNRESET') {
            result.error_type = 'connection_reset';
            result.error_message = 'Connection was reset by the server';
        } else if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
            result.error_type = 'connection_reset';
            result.error_message = 'Connection was closed unexpectedly';
        } else if (code === 'CERT_HAS_EXPIRED' || message.includes('certificate has expired')) {
            result.error_type = 'ssl_expired';
            result.error_message = 'SSL certificate has expired';
        } else if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
            result.error_type = 'ssl_verify';
            result.error_message = 'Unable to verify SSL certificate chain';
        } else if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || message.includes('altname')) {
            result.error_type = 'ssl_hostname';
            result.error_message = 'SSL certificate hostname mismatch';
        } else if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
            result.error_type = 'ssl_self_signed';
            result.error_message = 'SSL certificate is self-signed or from an untrusted CA';
        } else if (message.includes('SSL') || message.includes('TLS') || message.includes('certificate')) {
            result.error_type = 'ssl';
            result.error_message = `SSL/TLS error: ${message}`;
        } else if (code === 'ERR_FR_TOO_MANY_REDIRECTS' || message.includes('maxRedirects')) {
            result.error_type = 'too_many_redirects';
            result.error_message = `Too many redirects (max ${MAX_REDIRECTS})`;
        } else {
            result.error_type = 'unknown';
            result.error_message = message || 'Unknown error';
        }
    }

    return result;
}

export default checkHttp;
