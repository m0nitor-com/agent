import { describe, expect, it, vi } from 'vitest';
import {
    EgressDetector,
    parseEgressBody,
    sanitizeEgressIp,
} from '../src/lib/egress-detect.js';

describe('parseEgressBody', () => {
    it('parses cloudflare cdn-cgi/trace', () => {
        const body = [
            'fl=1',
            'h=cloudflare.com',
            'ip=203.0.113.10',
            'ts=1.0',
        ].join('\n');
        expect(parseEgressBody(body)).toBe('203.0.113.10');
    });

    it('parses plain-text IP responses', () => {
        expect(parseEgressBody('2001:db8::1\n')).toBe('2001:db8::1');
    });

    it('rejects empty or non-IP bodies', () => {
        expect(parseEgressBody('')).toBeNull();
        expect(parseEgressBody('hello')).toBeNull();
        expect(parseEgressBody('ip=not-an-ip')).toBeNull();
    });
});

describe('sanitizeEgressIp', () => {
    it('accepts matching public addresses', () => {
        expect(sanitizeEgressIp('8.8.8.8', 4)).toBe('8.8.8.8');
        expect(sanitizeEgressIp('2001:db8::1', 6)).toBeNull(); // documentation range
        expect(sanitizeEgressIp('2606:4700:4700::1111', 6)).toBe('2606:4700:4700::1111');
    });

    it('rejects private addresses and family mismatches', () => {
        expect(sanitizeEgressIp('10.0.0.1', 4)).toBeNull();
        expect(sanitizeEgressIp('127.0.0.1', 4)).toBeNull();
        expect(sanitizeEgressIp('8.8.8.8', 6)).toBeNull();
        expect(sanitizeEgressIp('2606:4700:4700::1111', 4)).toBeNull();
    });
});

describe('EgressDetector', () => {
    it('discovers both families and keeps prior values on partial failure', async () => {
        const requestFamily = vi.fn(async ({ family }) => {
            if (family === 4) return 'ip=1.1.1.1\n';
            throw Object.assign(new Error('no v6'), { code: 'ENETUNREACH' });
        });

        const detector = new EgressDetector({
            enabled: true,
            ttlMs: 60_000,
            requestFamily,
        });

        await detector.refresh();
        expect(detector.snapshot()).toEqual({
            ipv4: '1.1.1.1',
            ipv6: null,
            checked_at: expect.any(String),
        });

        requestFamily.mockImplementation(async ({ family }) => {
            if (family === 4) throw new Error('down');
            return 'ip=2606:4700:4700::1111\n';
        });

        await detector.refresh();
        expect(detector.snapshot().ipv4).toBe('1.1.1.1');
        expect(detector.snapshot().ipv6).toBe('2606:4700:4700::1111');
    });

    it('skips network work when disabled', async () => {
        const requestFamily = vi.fn();
        const detector = new EgressDetector({ enabled: false, requestFamily });
        await detector.refresh();
        expect(requestFamily).not.toHaveBeenCalled();
        expect(detector.snapshot().ipv4).toBeNull();
    });

    it('dedupes concurrent maybeRefresh calls and respects TTL', async () => {
        let releases = 0;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const requestFamily = vi.fn(async ({ family }) => {
            await gate;
            releases++;
            return family === 4 ? 'ip=1.0.0.1\n' : 'ip=2606:4700:4700::1\n';
        });

        const detector = new EgressDetector({
            enabled: true,
            ttlMs: 60_000,
            requestFamily,
        });

        const a = detector.maybeRefresh();
        const b = detector.maybeRefresh();
        expect(a).toBe(b);

        release();
        await a;
        expect(requestFamily).toHaveBeenCalledTimes(2);

        const afterTtl = detector.maybeRefresh();
        expect(afterTtl).toBeUndefined();
        expect(releases).toBe(2);
    });
});
