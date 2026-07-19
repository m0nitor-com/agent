import dns from 'dns/promises';
import net from 'net';
import { config as appConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { resolveAndCheck } from '../lib/ssrf.js';
import {
    DNS_RESOLUTION_TIMEOUT_MS,
    MAX_DNS_RECORDS,
    DEFAULT_MONITOR_TIMEOUT_S,
} from '../lib/constants.js';

/**
 * Race a promise against a timeout. The timer is always cleared so it never
 * leaks or keeps the event loop alive after the promise settles.
 */
const withTimeout = (promise, timeout, message) => {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
};

/**
 * Resolve a hostname to its IPs with a timeout. Uses a dual-stack lookup so a
 * custom DNS server given as an IPv6-only hostname still resolves (previously
 * only A records were queried).
 */
const resolveWithTimeout = (hostname, timeout = DNS_RESOLUTION_TIMEOUT_MS) => {
    return withTimeout(
        dns.lookup(hostname, { all: true }).then((list) => list.map((a) => a.address)),
        timeout,
        'DNS resolution timeout',
    );
};

/**
 * Singleton DNS resolver cache.
 * Reuses resolver instances keyed by their server configuration.
 */
const resolverCache = new Map();

function getResolver(servers) {
    const key = servers ? servers.sort().join(',') : '__system__';
    let resolver = resolverCache.get(key);
    if (!resolver) {
        resolver = new dns.Resolver();
        if (servers) {
            resolver.setServers(servers);
        }
        resolverCache.set(key, resolver);
    }
    return resolver;
}

/**
 * Execute a DNS check
 */
async function checkDns(monitor) {
    const start = Date.now();
    const hostname = monitor.url.replace(/^https?:\/\//, '').split('/')[0];
    const recordType = (monitor.method || 'A').toUpperCase();
    const expectedValue = monitor.success_criteria?.expected_value || null;
    const customServer = monitor.success_criteria?.dns_server || null;
    const queryTimeoutMs = (monitor.timeout || DEFAULT_MONITOR_TIMEOUT_S) * 1000;

    try {
        let results = [];
        let resolverServers = null;

        // SSRF mitigation: guard the DNS server we are about to query against —
        // NOT the queried hostname (legitimate DNS monitors may target public
        // domains that happen to resolve to internal IPs).
        const allowPrivate = monitor.allow_private_target === true || appConfig.ALLOW_PRIVATE_TARGETS === true;
        if (customServer && !allowPrivate) {
            const check = await resolveAndCheck(customServer);
            if (!check.ok && check.reason === 'blocked_private_target') {
                logger.warn({ monitor_id: monitor.id, dns_server: customServer, ip: check.ip }, '[DNS] Blocked private target');
                return {
                    monitor_id: monitor.id,
                    is_success: false,
                    response_time_ms: Date.now() - start,
                    error_type: 'blocked_private_target',
                    error_message: `DNS server ${customServer} resolves to a private/reserved IP (${check.ip})`,
                };
            }
        }

        if (customServer) {
            if (net.isIP(customServer)) {
                resolverServers = [customServer];
            } else {
                const ips = await resolveWithTimeout(customServer);
                if (ips.length > 0) {
                    resolverServers = ips;
                } else {
                    throw new Error(`Could not resolve custom DNS server hostname: ${customServer}`);
                }
            }
        }

        const resolver = getResolver(resolverServers);

        // The underlying c-ares queries are not bound by the monitor's timeout,
        // so race them against it to honor the configured hard limit.
        const runQuery = async () => {
            switch (recordType) {
                case 'A':
                    return await resolver.resolve4(hostname);
                case 'AAAA':
                    return await resolver.resolve6(hostname);
                case 'MX': {
                    const mx = await resolver.resolveMx(hostname);
                    return mx.map(r => `${r.exchange} (${r.priority})`);
                }
                case 'TXT': {
                    const txt = await resolver.resolveTxt(hostname);
                    return txt.flat();
                }
                case 'NS':
                    return await resolver.resolveNs(hostname);
                case 'CNAME':
                    return await resolver.resolveCname(hostname);
                case 'SOA': {
                    const soa = await resolver.resolveSoa(hostname);
                    return [`${soa.nsname} ${soa.hostmaster} ${soa.serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minttl}`];
                }
                case 'SRV': {
                    const srv = await resolver.resolveSrv(hostname);
                    return srv.map(s => `${s.name} ${s.port} ${s.priority} ${s.weight}`);
                }
                case 'PTR':
                    return await resolver.reverse(hostname);
                default:
                    throw new Error(`Unsupported record type: ${recordType}`);
            }
        };

        results = await withTimeout(runQuery(), queryTimeoutMs, 'DNS query timeout');

        const responseTime = Date.now() - start;

        const dnsInfo = {
            record_type: recordType,
            records: results.slice(0, MAX_DNS_RECORDS),
            server: customServer || 'system',
            record_count: results.length,
        };

        if (expectedValue) {
            const match = results.some(val =>
                String(val).toLowerCase().includes(expectedValue.toLowerCase())
            );

            if (!match) {
                return {
                    monitor_id: monitor.id,
                    is_success: false,
                    response_time_ms: responseTime,
                    error_type: 'dns_mismatch',
                    error_message: `Expected value "${expectedValue}" not found in results: ${results.join(', ')}`,
                    dns_info: dnsInfo,
                };
            }
        }

        return {
            monitor_id: monitor.id,
            is_success: true,
            response_time_ms: responseTime,
            dns_info: dnsInfo,
        };

    } catch (error) {
        const responseTime = Date.now() - start;
        const code = error.code || '';

        let errorType = 'dns_error';
        let errorMessage = `DNS Error: ${error.message}`;

        if (code === 'ENOTFOUND' || code === 'ENODATA') {
            errorType = 'dns';
            errorMessage = `No ${recordType} records found for ${hostname}`;
        } else if (code === 'ESERVFAIL') {
            errorType = 'dns_servfail';
            errorMessage = `DNS server failed to resolve ${hostname} (SERVFAIL)`;
        } else if (code === 'ETIMEOUT' || code === 'TIMEOUT' || (error.message || '').toLowerCase().includes('timeout')) {
            errorType = 'timeout';
            errorMessage = `DNS resolution timed out for ${hostname}`;
        } else if (code === 'EREFUSED' || code === 'ECONNREFUSED') {
            errorType = 'dns_refused';
            errorMessage = `DNS query was refused${customServer ? ` by ${customServer}` : ''}`;
        } else if (code === 'EFORMERR') {
            errorType = 'dns_format';
            errorMessage = `DNS query format error for ${hostname}`;
        } else if (code === 'ENOTIMP') {
            errorType = 'dns_not_implemented';
            errorMessage = `DNS server does not support ${recordType} queries`;
        }

        return {
            monitor_id: monitor.id,
            is_success: false,
            response_time_ms: responseTime,
            error_type: errorType,
            error_message: errorMessage,
        };
    }
}

export default checkDns;
