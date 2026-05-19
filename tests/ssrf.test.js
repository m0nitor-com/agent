import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { isPrivateIp, isUrlSafeScheme, resolveAndCheck } = await import('../src/lib/ssrf.js');

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
});
