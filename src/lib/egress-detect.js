/**
 * Discover the probe's public egress IPv4 and IPv6.
 *
 * Forced-family HTTPS GETs against a dual-stack echo endpoint (default:
 * Cloudflare /cdn-cgi/trace). Results are cached so poll cycles stay cheap.
 * Failures leave the previous good address for that family in place.
 *
 * This is the source of truth for firewall allowlists; it is independent of
 * the control-plane request IP recorded as last_ip on the backend.
 */

import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { isPrivateIp, familyLabel } from './ssrf.js';
import {
    EGRESS_DETECT_TIMEOUT_MS,
    EGRESS_DETECT_TTL_MS,
    DEFAULT_EGRESS_DETECT_URL,
} from './constants.js';

/**
 * Parse a public IP out of an echo-service body.
 * Supports Cloudflare cdn-cgi/trace (`ip=...`) and plain-text IP responses.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function parseEgressBody(body) {
    if (typeof body !== 'string') return null;
    const text = body.trim();
    if (!text) return null;

    if (familyLabel(text)) {
        return text;
    }

    const match = /^ip=([^\r\n]+)/m.exec(text);
    if (!match) return null;
    const candidate = match[1].trim();
    return familyLabel(candidate) ? candidate : null;
}

/**
 * @param {string|null|undefined} ip
 * @param {4|6} wantFamily
 * @returns {string|null}
 */
export function sanitizeEgressIp(ip, wantFamily) {
    if (typeof ip !== 'string' || ip === '') return null;
    const label = familyLabel(ip);
    if (label === null) return null;
    if (wantFamily === 4 && label !== 'ipv4') return null;
    if (wantFamily === 6 && label !== 'ipv6') return null;
    if (isPrivateIp(ip)) return null;
    return ip;
}

export class EgressDetector {
    /**
     * @param {{
     *   url?: string,
     *   ttlMs?: number,
     *   timeoutMs?: number,
     *   enabled?: boolean,
     *   skipSslVerify?: boolean,
     *   logger?: { debug?: Function, warn?: Function },
     *   requestFamily?: Function,
     * }} [opts]
     */
    constructor(opts = {}) {
        this.url = opts.url || DEFAULT_EGRESS_DETECT_URL;
        this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : EGRESS_DETECT_TTL_MS;
        this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : EGRESS_DETECT_TIMEOUT_MS;
        this.enabled = opts.enabled !== false;
        this.skipSslVerify = opts.skipSslVerify === true;
        this.logger = opts.logger || null;
        this.requestFamily = opts.requestFamily || defaultRequestFamily;
        this.state = { ipv4: null, ipv6: null, checked_at: null };
        this.nextRefreshAt = 0;
        this.refreshPromise = null;
    }

    /**
     * @returns {{ ipv4: string|null, ipv6: string|null, checked_at: string|null }}
     */
    snapshot() {
        return {
            ipv4: this.state.ipv4,
            ipv6: this.state.ipv6,
            checked_at: this.state.checked_at,
        };
    }

    /**
     * Kick a background refresh when the TTL has elapsed. Never throws.
     * Concurrent callers share one in-flight refresh.
     *
     * @param {AbortSignal} [signal]
     * @returns {Promise<void>|undefined}
     */
    maybeRefresh(signal) {
        if (!this.enabled) return undefined;
        if (this.refreshPromise) return this.refreshPromise;
        if (Date.now() < this.nextRefreshAt) return undefined;

        this.refreshPromise = this.refresh(signal)
            .catch((error) => {
                this.logger?.warn?.(
                    { code: error?.code, name: error?.name },
                    '[EGRESS] Refresh failed',
                );
            })
            .finally(() => {
                this.refreshPromise = null;
            });

        return this.refreshPromise;
    }

    /**
     * @param {AbortSignal} [signal]
     */
    async refresh(signal) {
        if (!this.enabled) return;

        const [ipv4, ipv6] = await Promise.all([
            this.detectFamily(4, signal),
            this.detectFamily(6, signal),
        ]);

        this.state = {
            ipv4: ipv4 ?? this.state.ipv4,
            ipv6: ipv6 ?? this.state.ipv6,
            checked_at: new Date().toISOString(),
        };
        this.nextRefreshAt = Date.now() + this.ttlMs;

        this.logger?.debug?.(
            { ipv4: this.state.ipv4, ipv6: this.state.ipv6 },
            '[EGRESS] Snapshot updated',
        );
    }

    /**
     * @param {4|6} family
     * @param {AbortSignal} [signal]
     * @returns {Promise<string|null>}
     */
    async detectFamily(family, signal) {
        try {
            const body = await this.requestFamily({
                url: this.url,
                family,
                timeoutMs: this.timeoutMs,
                skipSslVerify: this.skipSslVerify,
                signal,
            });
            return sanitizeEgressIp(parseEgressBody(body), family);
        } catch (error) {
            if (signal?.aborted) return null;
            this.logger?.debug?.(
                { family, code: error?.code, name: error?.name },
                '[EGRESS] Family probe failed',
            );
            return null;
        }
    }
}

/**
 * @param {{
 *   url: string,
 *   family: 4|6,
 *   timeoutMs: number,
 *   skipSslVerify: boolean,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<string>}
 */
function defaultRequestFamily(opts) {
    return new Promise((resolve, reject) => {
        if (opts.signal?.aborted) {
            reject(opts.signal.reason || new Error('aborted'));
            return;
        }

        let parsed;
        try {
            parsed = new URL(opts.url);
        } catch (error) {
            reject(error);
            return;
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            reject(new Error('egress_url_scheme'));
            return;
        }

        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;
        const chunks = [];
        let settled = false;

        const req = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: `${parsed.pathname}${parsed.search}`,
            method: 'GET',
            family: opts.family,
            servername: parsed.hostname,
            timeout: opts.timeoutMs,
            rejectUnauthorized: !opts.skipSslVerify,
            headers: {
                Accept: 'text/plain,*/*',
                'User-Agent': 'm0nitor-agent-egress/1',
                Connection: 'close',
            },
            agent: false,
        }, (res) => {
            res.on('data', (chunk) => {
                if (chunks.length < 8) chunks.push(chunk);
            });
            res.on('end', () => {
                if (settled) return;
                settled = true;
                const status = res.statusCode || 0;
                if (status < 200 || status >= 300) {
                    reject(Object.assign(new Error('egress_http_status'), { code: 'EGRESS_HTTP', status }));
                    return;
                }
                resolve(Buffer.concat(chunks).toString('utf8'));
            });
        });

        const onAbort = () => {
            req.destroy(opts.signal?.reason || new Error('aborted'));
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });

        req.on('timeout', () => {
            req.destroy(Object.assign(new Error('egress_timeout'), { code: 'ETIMEDOUT' }));
        });
        req.on('error', (error) => {
            if (settled) return;
            settled = true;
            opts.signal?.removeEventListener('abort', onAbort);
            reject(error);
        });
        req.on('close', () => {
            opts.signal?.removeEventListener('abort', onAbort);
        });
        req.end();
    });
}
