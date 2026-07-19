import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { isPrivateIp, isUrlSafeScheme, resolveAndCheck, stripBrackets, familyToNum, familyLabel, effectiveFamily } = await import('../src/lib/ssrf.js');

describe('isPrivateIp', () => {
    it('returns true for common IPv4 private/reserved ranges', () => {
        expect(isPrivateIp('127.0.0.1')).toBe(true);
        expect(isPrivateIp('10.1.2.3')).toBe(true);
        expect(isPrivateIp('192.168.0.1')).toBe(true);
        expect(isPrivateIp('172.16.0.1')).toBe(true);
        expect(isPrivateIp('169.254.169.254')).toBe(true);
    });

    it('returns true for CGNAT (100.64.0.0/10)', () => {
        expect(isPrivateIp('100.64.0.1')).toBe(true);
    });

    it('returns true for IPv6 private/reserved ranges', () => {
        expect(isPrivateIp('::1')).toBe(true);
        expect(isPrivateIp('fe80::1')).toBe(true);
        expect(isPrivateIp('fc00::1')).toBe(true);
        expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('returns false for public IPs', () => {
        expect(isPrivateIp('8.8.8.8')).toBe(false);
        expect(isPrivateIp('1.1.1.1')).toBe(false);
        expect(isPrivateIp('2606:4700::1111')).toBe(false);
    });

    it('fail-closed: returns true for invalid inputs', () => {
        expect(isPrivateIp('not-an-ip')).toBe(true);
        expect(isPrivateIp(null)).toBe(true);
        expect(isPrivateIp('')).toBe(true);
    });
});

describe('isUrlSafeScheme', () => {
    it('returns false for dangerous schemes', () => {
        expect(isUrlSafeScheme('file:///etc/passwd')).toBe(false);
        expect(isUrlSafeScheme('gopher://example.com/')).toBe(false);
        expect(isUrlSafeScheme('javascript:alert(1)')).toBe(false);
    });

    it('returns true for http and https schemes', () => {
        expect(isUrlSafeScheme('http://example.com')).toBe(true);
        expect(isUrlSafeScheme('https://example.com')).toBe(true);
    });
});

describe('resolveAndCheck', () => {
    it('blocks an IP literal in a private range', async () => {
        const result = await resolveAndCheck('10.0.0.1');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('blocked_private_target');
        expect(result.ip).toBe('10.0.0.1');
    });

    it('allows a public IP literal', async () => {
        const result = await resolveAndCheck('8.8.8.8');
        expect(result.ok).toBe(true);
        expect(result.ip).toBe('8.8.8.8');
    });

    it('blocks when injected DNS lookup returns a private address', async () => {
        const dnsLookup = async () => [{ address: '169.254.169.254', family: 4 }];
        const result = await resolveAndCheck('metadata.example.com', { dnsLookup });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('blocked_private_target');
        expect(result.ip).toBe('169.254.169.254');
    });

    it('STRICT: blocks if ANY resolved address is private', async () => {
        const dnsLookup = async () => [
            { address: '8.8.8.8', family: 4 },
            { address: '::1', family: 6 },
        ];
        const result = await resolveAndCheck('mixed.example.com', { dnsLookup });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('blocked_private_target');
        expect(result.ip).toBe('::1');
    });

    it('returns dns_failure when injected lookup throws ENOTFOUND', async () => {
        const dnsLookup = async () => {
            const err = new Error('getaddrinfo ENOTFOUND nope.example');
            err.code = 'ENOTFOUND';
            throw err;
        };
        const result = await resolveAndCheck('nope.example', { dnsLookup });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('dns_failure');
    });

    it('returns dns_failure when injected lookup returns an empty list', async () => {
        const dnsLookup = async () => [];
        const result = await resolveAndCheck('empty.example', { dnsLookup });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('dns_failure');
    });

    it('allows hostname when all resolved addresses are public', async () => {
        const dnsLookup = async () => [
            { address: '8.8.8.8', family: 4 },
            { address: '2606:4700::1111', family: 6 },
        ];
        const result = await resolveAndCheck('public.example', { dnsLookup });
        expect(result.ok).toBe(true);
        expect(result.ip).toBe('8.8.8.8');
        expect(result.family).toBe(4);
    });

    // Regression: URL.hostname keeps the brackets for IPv6 literals, which used to
    // slip past the guard entirely (ipaddr.isValid('[::1]') === false).
    it('blocks a bracketed IPv6 loopback literal', async () => {
        const result = await resolveAndCheck('[::1]');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('blocked_private_target');
    });

    it('blocks a bracketed IPv4-mapped metadata literal', async () => {
        const result = await resolveAndCheck('[::ffff:169.254.169.254]');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('blocked_private_target');
    });

    it('allows a bracketed public IPv6 literal', async () => {
        const result = await resolveAndCheck('[2606:4700::1111]');
        expect(result.ok).toBe(true);
        expect(result.ip).toBe('2606:4700::1111');
        expect(result.family).toBe(6);
    });

    it('selects the requested family (ipv6) from a dual-stack host', async () => {
        const dnsLookup = async () => [
            { address: '8.8.8.8', family: 4 },
            { address: '2606:4700::1111', family: 6 },
        ];
        const result = await resolveAndCheck('public.example', { dnsLookup, family: 'ipv6' });
        expect(result.ok).toBe(true);
        expect(result.ip).toBe('2606:4700::1111');
        expect(result.family).toBe(6);
    });

    it('selects the requested family (ipv4) from a dual-stack host', async () => {
        const dnsLookup = async () => [
            { address: '2606:4700::1111', family: 6 },
            { address: '8.8.8.8', family: 4 },
        ];
        const result = await resolveAndCheck('public.example', { dnsLookup, family: 'ipv4' });
        expect(result.ok).toBe(true);
        expect(result.ip).toBe('8.8.8.8');
        expect(result.family).toBe(4);
    });

    it('reports family_unavailable when the requested family is absent', async () => {
        const dnsLookup = async () => [{ address: '8.8.8.8', family: 4 }];
        const result = await resolveAndCheck('v4only.example', { dnsLookup, family: 'ipv6' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('family_unavailable');
    });

    it('reports family_unavailable for a literal of the wrong family', async () => {
        const result = await resolveAndCheck('8.8.8.8', { family: 'ipv6' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('family_unavailable');
    });

    it('allowPrivate lets a private literal through (and pins it)', async () => {
        const result = await resolveAndCheck('10.0.0.1', { allowPrivate: true });
        expect(result.ok).toBe(true);
        expect(result.ip).toBe('10.0.0.1');
        expect(result.family).toBe(4);
    });
});

describe('isPrivateIp - bracketed literals and documentation range', () => {
    it('blocks bracketed private IPv6 literals', () => {
        expect(isPrivateIp('[::1]')).toBe(true);
        expect(isPrivateIp('[fe80::1]')).toBe(true);
        expect(isPrivateIp('[::ffff:169.254.169.254]')).toBe(true);
    });

    it('blocks the 2001:db8::/32 documentation range', () => {
        expect(isPrivateIp('2001:db8::1')).toBe(true);
        expect(isPrivateIp('[2001:db8::dead]')).toBe(true);
    });

    it('still allows a bracketed public IPv6 literal', () => {
        expect(isPrivateIp('[2606:4700::1111]')).toBe(false);
    });
});

describe('family helpers', () => {
    it('stripBrackets removes IPv6 literal brackets only', () => {
        expect(stripBrackets('[::1]')).toBe('::1');
        expect(stripBrackets('8.8.8.8')).toBe('8.8.8.8');
        expect(stripBrackets('example.com')).toBe('example.com');
    });

    it('familyToNum maps labels/numbers to 4/6/0', () => {
        expect(familyToNum('ipv6')).toBe(6);
        expect(familyToNum('ipv4')).toBe(4);
        expect(familyToNum('auto')).toBe(0);
        expect(familyToNum(undefined)).toBe(0);
    });

    it('familyLabel maps numbers and IPs to labels', () => {
        expect(familyLabel(6)).toBe('ipv6');
        expect(familyLabel(4)).toBe('ipv4');
        expect(familyLabel('2606:4700::1')).toBe('ipv6');
        expect(familyLabel('8.8.8.8')).toBe('ipv4');
        expect(familyLabel('not-an-ip')).toBe(null);
    });

    it('effectiveFamily prefers the monitor value, then the config default', () => {
        expect(effectiveFamily('ipv6', 'auto')).toBe('ipv6');
        expect(effectiveFamily(null, 'ipv4')).toBe('ipv4');
        expect(effectiveFamily(null, 'auto')).toBe(undefined);
        expect(effectiveFamily('ipv4', 'ipv6')).toBe('ipv4');
    });
});
