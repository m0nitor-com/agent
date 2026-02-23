import axios from 'axios';
import https from 'https';
import http from 'http';
import tls from 'tls';
import { logger } from '../lib/logger.js';
import { config as appConfig } from '../lib/config.js';

/**
 * Essential response headers worth keeping for diagnostics.
 * Everything else is noise and wastes bandwidth/storage.
 */
const ESSENTIAL_HEADERS = [
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
];

/**
 * Filter response headers to only essential ones.
 */
function filterHeaders(headers) {
    if (!headers) return null;
    const filtered = {};
    for (const key of ESSENTIAL_HEADERS) {
        if (headers[key] !== undefined) {
            filtered[key] = headers[key];
        }
    }
    return Object.keys(filtered).length > 0 ? filtered : null;
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

    try {
        // Build request headers with sensible defaults
        const headers = { ...(monitor.headers || {}) };

        // Default User-Agent
        if (!headers['User-Agent'] && !headers['user-agent']) {
            headers['User-Agent'] = 'm0nitor/1.0';
        }

        // Default Accept header
        if (!headers['Accept'] && !headers['accept']) {
            headers['Accept'] = '*/*';
        }

        // Auto Content-Type for body requests (if not explicitly set)
        const method = (monitor.method || 'GET').toUpperCase();
        if (monitor.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
            if (!headers['Content-Type'] && !headers['content-type']) {
                headers['Content-Type'] = isJsonLike(monitor.body)
                    ? 'application/json'
                    : 'text/plain';
            }
        }

        const isHttps = monitor.url?.startsWith('https://');

        // Build request config
        const config = {
            method,
            url: monitor.url,
            timeout: (monitor.timeout || 30) * 1000,
            headers,
            maxRedirects: monitor.follow_redirects ? 5 : 0,
            validateStatus: () => true, // Accept any status code
        };

        // Only create httpsAgent for HTTPS URLs
        // Respect monitor-level ssl_check setting: if unchecked, don't reject invalid certs
        // Global SKIP_SSL_VERIFY env var overrides for dev environments
        if (isHttps) {
            const sslCheck = monitor.success_criteria?.ssl_check !== false; // default true
            config.httpsAgent = new https.Agent({
                rejectUnauthorized: sslCheck && !appConfig.SKIP_SSL_VERIFY,
            });
        } else {
            config.httpAgent = new http.Agent();
        }

        if (monitor.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
            config.data = monitor.body;
        }

        // Make the request
        const response = await axios(config);

        result.response_time_ms = Date.now() - startTime;
        result.status_code = response.status;

        // Filter response headers to essential ones only
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

        // Get response body preview (first 1KB)
        if (typeof response.data === 'string') {
            result.response_body_preview = response.data.substring(0, 1024);
        } else if (typeof response.data === 'object') {
            result.response_body_preview = JSON.stringify(response.data).substring(0, 1024);
        }

        // Check success criteria
        const criteria = monitor.success_criteria || {};
        const acceptedCodes = criteria.status_codes || [200, 201, 202, 203, 204];
        const maxResponseTime = criteria.max_response_time || 30000;

        // Check status code
        if (!acceptedCodes.includes(response.status)) {
            result.is_success = false;
            result.error_type = 'status_code';
            result.error_message = `Expected status ${acceptedCodes.join('/')}, got ${response.status}`;
            return result;
        }

        // Check response time
        if (result.response_time_ms > maxResponseTime) {
            result.is_success = false;
            result.error_type = 'response_time';
            result.error_message = `Response time ${result.response_time_ms}ms exceeds limit ${maxResponseTime}ms`;
            return result;
        }

        // Check keywords if specified
        if (criteria.keywords && criteria.keywords.length > 0) {
            // Search against full response body, not just the 1KB preview
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

        // SSL check for HTTPS monitors — extract cert from existing connection (no extra request!)
        if (monitor.type === 'https' && criteria.ssl_check !== false) {
            try {
                let cert = null;

                // Try to get cert from the existing axios response socket
                const socket = response.request?.socket || response.request?.res?.socket;
                if (socket && typeof socket.getPeerCertificate === 'function') {
                    cert = socket.getPeerCertificate(true);
                }

                // Fallback: raw TLS connect (only if socket cert unavailable, e.g. after redirects)
                if (!cert || !cert.valid_to) {
                    const urlObj = new URL(monitor.url);
                    cert = await new Promise((resolve, reject) => {
                        const tlsSocket = tls.connect(
                            { host: urlObj.hostname, port: parseInt(urlObj.port) || 443, servername: urlObj.hostname, timeout: 10000 },
                            () => {
                                const peerCert = tlsSocket.getPeerCertificate();
                                tlsSocket.destroy();
                                resolve(peerCert);
                            }
                        );
                        tlsSocket.on('error', (err) => { tlsSocket.destroy(); reject(err); });
                        tlsSocket.setTimeout(10000, () => { tlsSocket.destroy(); reject(new Error('TLS handshake timeout')); });
                    });
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

                    const minDays = criteria.ssl_min_days || 7;
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

        // Timeout errors
        if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT') {
            result.error_type = 'timeout';
            result.error_message = `Connection timed out after ${monitor.timeout || 30}s`;

            // DNS errors
        } else if (code === 'ENOTFOUND') {
            result.error_type = 'dns';
            result.error_message = `DNS resolution failed for ${monitor.url}`;
        } else if (code === 'EAI_AGAIN') {
            result.error_type = 'dns_temporary';
            result.error_message = `Temporary DNS failure for ${monitor.url} (try again later)`;

            // Connection errors
        } else if (code === 'ECONNREFUSED') {
            result.error_type = 'connection';
            result.error_message = 'Connection refused';
        } else if (code === 'ECONNRESET') {
            result.error_type = 'connection_reset';
            result.error_message = 'Connection was reset by the server';
        } else if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
            result.error_type = 'connection_reset';
            result.error_message = 'Connection was closed unexpectedly';

            // TLS/SSL errors
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

            // Redirect limit
        } else if (code === 'ERR_FR_TOO_MANY_REDIRECTS' || message.includes('maxRedirects')) {
            result.error_type = 'too_many_redirects';
            result.error_message = 'Too many redirects (max 5)';

            // Catch-all
        } else {
            result.error_type = 'unknown';
            result.error_message = message || 'Unknown error';
        }
    }

    return result;
}

export default checkHttp;
