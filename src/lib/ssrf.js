import ipaddr from 'ipaddr.js';
import dns from 'dns/promises';
import net from 'net';
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

// ipaddr.js has no range name for the documentation prefix (2001:db8::/32), so it
// is matched explicitly. It is reserved and must never be a real monitor target.
const DOCUMENTATION_IPV6 = ipaddr.parseCIDR('2001:db8::/32');

/**
 * Strip the surrounding brackets from an IPv6 literal (e.g. "[::1]" -> "::1").
 * URL.hostname keeps the brackets for IPv6 literals; ipaddr.js and net.isIP
 * reject the bracketed form, so every IP comparison must normalize first.
 * Without this, "http://[::1]/" slips past the SSRF guard entirely.
 */
export function stripBrackets(host) {
    if (typeof host !== 'string') return host;
    if (host.length > 1 && host[0] === '[' && host[host.length - 1] === ']') {
        return host.slice(1, -1);
    }
    return host;
}

/**
 * Normalize an address family to Node's numeric form (4 or 6). Returns 0 for
 * "no preference" (auto), accepting both 'ipv4'/'ipv6' strings and 4/6 numbers.
 */
export function familyToNum(family) {
    if (family === 'ipv6' || family === 6) return 6;
    if (family === 'ipv4' || family === 4) return 4;
    return 0;
}

/**
 * Return the platform's family label ('ipv4'|'ipv6') for a numeric family or an
 * IP string, or null if it cannot be determined.
 */
export function familyLabel(value) {
    if (value === 6 || value === 'ipv6') return 'ipv6';
    if (value === 4 || value === 'ipv4') return 'ipv4';
    const v = net.isIP(stripBrackets(String(value ?? '')));
    return v === 6 ? 'ipv6' : v === 4 ? 'ipv4' : null;
}

/**
 * Resolve the effective family for a check: the per-monitor value wins, then the
 * worker's IP_FAMILY default; returns undefined (auto) when neither forces one.
 */
export function effectiveFamily(monitorFamily, configDefault) {
    if (monitorFamily === 'ipv4' || monitorFamily === 'ipv6') return monitorFamily;
    if (configDefault === 'ipv4' || configDefault === 'ipv6') return configDefault;
    return undefined;
}

/**
 * Return true if the given IP string falls in a private/reserved range.
 * Fail-closed: any parse error returns true so unknown input is treated as unsafe.
 */
export function isPrivateIp(ipString) {
    try {
        if (!ipString || typeof ipString !== 'string') return true;
        const parsed = ipaddr.parse(stripBrackets(ipString));
        const range = parsed.range();
        if (parsed.kind() === 'ipv4') {
            return BLOCKED_IPV4_RANGES.has(range);
        }
        if (BLOCKED_IPV6_RANGES.has(range)) return true;
        return parsed.match(DOCUMENTATION_IPV6);
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
 * STRICT semantics: if ANY resolved address is private, the whole hostname is rejected
 * (unless opts.allowPrivate is set). When opts.family is given, only an address of that
 * family is returned; 'family_unavailable' is reported if the host has none.
 *
 * @param {string} hostname
 * @param {{ dnsLookup?: Function, family?: string|number, allowPrivate?: boolean }} [opts]
 * @returns {Promise<{ok:true, ip:string, family:number} | {ok:false, reason:string, ip?:string, family?:number, error?:Error}>}
 */
export async function resolveAndCheck(hostname, opts = {}) {
    if (!hostname || typeof hostname !== 'string') {
        return { ok: false, reason: 'invalid_hostname' };
    }

    const host = stripBrackets(hostname);
    const wantFamily = familyToNum(opts.family); // 0 = any family
    const allowPrivate = opts.allowPrivate === true;

    // IP literal short-circuit — no DNS needed.
    if (ipaddr.isValid(host)) {
        const family = host.includes(':') ? 6 : 4;
        if (wantFamily && wantFamily !== family) {
            return { ok: false, reason: 'family_unavailable', ip: host, family };
        }
        if (!allowPrivate && isPrivateIp(host)) {
            return { ok: false, reason: 'blocked_private_target', ip: host, family };
        }
        return { ok: true, ip: host, family };
    }

    const lookup = opts.dnsLookup || dns.lookup;

    let addrs;
    try {
        addrs = await lookup(host, { all: true, verbatim: true });
    } catch (error) {
        logger.debug({ hostname: host, err: error?.message }, '[SSRF] DNS lookup failed');
        return { ok: false, reason: 'dns_failure', error };
    }

    if (!Array.isArray(addrs) || addrs.length === 0) {
        return { ok: false, reason: 'dns_failure' };
    }

    // STRICT: reject if ANY resolved address (any family) is private/reserved.
    if (!allowPrivate) {
        for (const addr of addrs) {
            if (isPrivateIp(addr.address)) {
                return { ok: false, reason: 'blocked_private_target', ip: addr.address, family: addr.family };
            }
        }
    }

    const pool = wantFamily ? addrs.filter((a) => a.family === wantFamily) : addrs;
    if (pool.length === 0) {
        return { ok: false, reason: 'family_unavailable', family: wantFamily };
    }

    return { ok: true, ip: pool[0].address, family: pool[0].family };
}
