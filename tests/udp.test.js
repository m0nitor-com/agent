import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';
import dgram from 'dgram';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// SSRF guard OFF for this suite (existing fixtures use private IPs like 192.168.1.1).
vi.mock('../src/lib/config.js', () => ({
    config: { ALLOW_PRIVATE_TARGETS: true, IP_FAMILY: 'auto' },
}));

// Pin resolution: return the host as-is with a family derived from its shape, so
// the check picks udp4/udp6 and reports resolved_ip without touching real DNS.
vi.mock('../src/lib/ssrf.js', () => ({
    resolveAndCheck: vi.fn(async (host) => ({ ok: true, ip: host, family: String(host).includes(':') ? 6 : 4 })),
    effectiveFamily: () => undefined,
    familyLabel: (v) => (v === 6 ? 'ipv6' : 'ipv4'),
}));

let mockSocket;

vi.mock('dgram', () => ({
    default: {
        createSocket: vi.fn(() => mockSocket),
    },
}));

const { checkUdp } = await import('../src/checks/udp.js');

describe('checkUdp', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockSocket = new EventEmitter();
        mockSocket.send = vi.fn((msg, port, host, cb) => cb && cb(null));
        mockSocket.close = vi.fn();
    });

    const baseMonitor = {
        id: 1,
        url: '192.168.1.1',
        port: 53,
        timeout: 2,
        success_criteria: { max_response_time: 30000 },
    };

    it('returns success on timeout (no ICMP unreachable = port open)', async () => {
        const promise = checkUdp(baseMonitor);
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(result.is_success).toBe(true);
        expect(result.monitor_id).toBe(1);
        expect(result.response_time_ms).toBeTypeOf('number');
        expect(dgram.createSocket).toHaveBeenCalledWith('udp4');
        expect(result.resolved_ip).toBe('192.168.1.1');
        expect(result.family).toBe('ipv4');
    });

    it('opens a udp6 socket and reports ipv6 for IPv6 targets', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            expect(host).toBe('::1');
            cb(null);
            process.nextTick(() => mockSocket.emit('message', Buffer.from('ok'), {}));
        });

        vi.useRealTimers();
        const result = await checkUdp({ ...baseMonitor, url: '[::1]', port: 53 });
        expect(dgram.createSocket).toHaveBeenCalledWith('udp6');
        expect(result.family).toBe('ipv6');
        expect(result.resolved_ip).toBe('::1');
        expect(result.is_success).toBe(true);
    });

    it('returns success when message is received', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            cb(null);
            process.nextTick(() => mockSocket.emit('message', Buffer.from('pong'), {}));
        });

        vi.useRealTimers();
        const result = await checkUdp(baseMonitor);
        expect(result.is_success).toBe(true);
    });

    it('returns dns error on ENOTFOUND', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            cb(null);
            process.nextTick(() => {
                const err = new Error('Not found');
                err.code = 'ENOTFOUND';
                mockSocket.emit('error', err);
            });
        });

        vi.useRealTimers();
        const result = await checkUdp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns');
    });

    it('returns host_unreachable on EHOSTUNREACH', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            cb(null);
            process.nextTick(() => {
                const err = new Error('Unreachable');
                err.code = 'EHOSTUNREACH';
                mockSocket.emit('error', err);
            });
        });

        vi.useRealTimers();
        const result = await checkUdp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('host_unreachable');
    });

    it('returns connection error on ECONNREFUSED', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            cb(null);
            process.nextTick(() => {
                const err = new Error('Refused');
                err.code = 'ECONNREFUSED';
                mockSocket.emit('error', err);
            });
        });

        vi.useRealTimers();
        const result = await checkUdp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection');
    });

    it('returns dns error on send failure with ENOTFOUND', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            const err = new Error('Not found');
            err.code = 'ENOTFOUND';
            cb(err);
        });

        vi.useRealTimers();
        const result = await checkUdp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns');
    });

    it('returns connection error on generic send failure', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            cb(new Error('Send failed'));
        });

        vi.useRealTimers();
        const result = await checkUdp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection');
    });

    it('extracts host/port from URL with protocol', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            expect(host).toBe('example.com');
            expect(port).toBe(5353);
            cb(null);
            process.nextTick(() => mockSocket.emit('message', Buffer.from('ok'), {}));
        });

        vi.useRealTimers();
        const result = await checkUdp({ ...baseMonitor, url: 'udp://example.com', port: 5353 });
        expect(result.is_success).toBe(true);
    });

    it('returns permission error on EACCES', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            cb(null);
            process.nextTick(() => {
                const err = new Error('Permission denied');
                err.code = 'EACCES';
                mockSocket.emit('error', err);
            });
        });

        vi.useRealTimers();
        const result = await checkUdp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('permission');
    });

    it('returns unknown error for unrecognized codes', async () => {
        mockSocket.send = vi.fn((msg, port, host, cb) => {
            cb(null);
            process.nextTick(() => {
                const err = new Error('Weird error');
                err.code = 'EWHATEVER';
                mockSocket.emit('error', err);
            });
        });

        vi.useRealTimers();
        const result = await checkUdp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('unknown');
    });
});
