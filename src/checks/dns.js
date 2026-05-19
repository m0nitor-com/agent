import dns from 'dns/promises';
import net from 'net';
import { config as appConfig } from '../lib/config.js';
import { resolveAndCheck } from '../lib/ssrf.js';
import {
    DNS_RESOLUTION_TIMEOUT_MS,
    MAX_DNS_RECORDS,
    DEFAULT_MAX_RESPONSE_TIME_MS,
} from '../lib/constants.js';

/**
 * Resolve a hostname with a timeout.
 */
const resolveWithTimeout = (hostname, timeout = DNS_RESOLUTION_TIMEOUT_MS) => {
    return Promise.race([
        dns.resolve4(hostname),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DNS resolution timeout')), timeout))
    ]);
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
    const maxResponseTime = monitor.success_criteria?.max_response_time || DEFAULT_MAX_RESPONSE_TIME_MS;

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

        switch (recordType) {
            case 'A':
                results = await resolver.resolve4(hostname);
                break;
            case 'AAAA':
                results = await resolver.resolve6(hostname);
                break;
            case 'MX':
                results = await resolver.resolveMx(hostname);
                results = results.map(r => `${r.exchange} (${r.priority})`);
                break;
            case 'TXT':
                results = await resolver.resolveTxt(hostname);
                results = results.flat();
                break;
            case 'NS':
                results = await resolver.resolveNs(hostname);
                break;
            case 'CNAME':
                results = await resolver.resolveCname(hostname);
                break;
            case 'SOA': {
                const soa = await resolver.resolveSoa(hostname);
                results = [`${soa.nsname} ${soa.hostmaster} ${soa.serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minttl}`];
                break;
            }
            case 'SRV': {
                const srv = await resolver.resolveSrv(hostname);
                results = srv.map(s => `${s.name} ${s.port} ${s.priority} ${s.weight}`);
            }
                break;
            case 'PTR':
                results = await resolver.reverse(hostname);
                break;
            default:
                throw new Error(`Unsupported record type: ${recordType}`);
        }

        const responseTime = Date.now() - start;

        const dnsInfo = {
            record_type: recordType,
            records: results.slice(0, MAX_DNS_RECORDS),
            server: customServer || 'system',
            record_count: results.length,
        };

        if (responseTime > maxResponseTime) {
            return {
                monitor_id: monitor.id,
                is_success: false,
                response_time_ms: responseTime,
                error_type: 'response_time',
                error_message: `DNS resolution took ${responseTime}ms (limit: ${maxResponseTime}ms)`,
                dns_info: dnsInfo,
            };
        }

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
        } else if (code === 'ETIMEOUT' || code === 'TIMEOUT') {
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
