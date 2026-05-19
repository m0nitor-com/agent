import ipaddr from 'ipaddr.js';
import dns from 'dns/promises';
import { logger } from './logger.js';

/**
 * IPv4 range categories considered private/reserved and unsafe as monitor targets.
 */
const BLOCKED_IPV4_RANGES = new Set([
    'private',
    'loopback',
    'linkLocal',
    'uniqueLocal',
    'unspecified',
    'broadcast',
    'carrierGradeNat',
    'reserved',
    'multicast',
]);

/**
 * IPv6 range categories considered private/reserved and unsafe as monitor targets.
 */
const BLOCKED_IPV6_RANGES = new Set([
    'loopback',
    'linkLocal',
    'uniqueLocal',
    'unspecified',
    'reserved',
    'ipv4Mapped',
    'rfc6145',
    'rfc6052',
    '6to4',
    'teredo',
    'multicast',
]);

/**
 * Return true if the given IP string falls in a private/reserved range.
 * Fail-closed: any parse error returns true so unknown input is treated as unsafe.
 */
export function isPrivateIp(ipString) {
    try {
        if (!ipString || typeof ipString !== 'string') return true;
        const parsed = ipaddr.parse(ipString);
        const range = parsed.range();
        if (parsed.kind() === 'ipv4') {
            return BLOCKED_IPV4_RANGES.has(range);
        }
        return BLOCKED_IPV6_RANGES.has(range);
    } catch {
        return true;
    }
}

/**
 * Return true iff the URL parses and uses http: or https: scheme.
 */
export function isUrlSafeScheme(urlString) {
    try {
        const u = new URL(urlString);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Resolve a hostname (or IP literal) and check that no resolved address is private/reserved.
 *
 * STRICT semantics: if ANY resolved address is private, the whole hostname is rejected.
 *
 * @param {string} hostname
 * @param {{ dnsLookup?: Function }} [opts]
 * @returns {Promise<{ok:true, ip:string, family:number} | {ok:false, reason:string, ip?:string, error?:Error}>}
 */
export async function resolveAndCheck(hostname, opts = {}) {
    if (!hostname || typeof hostname !== 'string') {
        return { ok: false, reason: 'invalid_hostname' };
    }

    // IP literal short-circuit — no DNS needed.
    if (ipaddr.isValid(hostname)) {
        const family = hostname.includes(':') ? 6 : 4;
        if (isPrivateIp(hostname)) {
            return { ok: false, reason: 'blocked_private_target', ip: hostname, family };
        }
        return { ok: true, ip: hostname, family };
    }

    const lookup = opts.dnsLookup || dns.lookup;

    let addrs;
    try {
        addrs = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
        logger.debug({ hostname, err: error?.message }, '[SSRF] DNS lookup failed');
        return { ok: false, reason: 'dns_failure', error };
    }

    if (!Array.isArray(addrs) || addrs.length === 0) {
        return { ok: false, reason: 'dns_failure' };
    }

    for (const addr of addrs) {
        if (isPrivateIp(addr.address)) {
            return { ok: false, reason: 'blocked_private_target', ip: addr.address };
        }
    }

    return { ok: true, ip: addrs[0].address, family: addrs[0].family };
}
