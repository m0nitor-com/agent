import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// SSRF guard OFF for this suite so existing tests run unimpeded.
vi.mock('../src/lib/config.js', () => ({
    config: { ALLOW_PRIVATE_TARGETS: true, IP_FAMILY: 'auto' },
}));

// Pin resolution so the check connects to a deterministic IP without real DNS.
vi.mock('../src/lib/ssrf.js', () => ({
    resolveAndCheck: vi.fn(async () => ({ ok: true, ip: '93.184.216.34', family: 4 })),
    effectiveFamily: () => undefined,
    familyLabel: (v) => (v === 6 ? 'ipv6' : 'ipv4'),
}));

let mockSocket;

function createMockSocket() {
    mockSocket = new EventEmitter();
    mockSocket.setTimeout = vi.fn();
    mockSocket.connect = vi.fn();
    mockSocket.destroy = vi.fn();
    mockSocket.off = vi.fn();
    return mockSocket;
}

vi.mock('net', () => ({
    default: {
        Socket: class MockSocket {
            constructor() {
                const s = createMockSocket();
                Object.assign(this, s);
                // Copy EventEmitter methods
                this.on = s.on.bind(s);
                this.emit = s.emit.bind(s);
                this.off = s.off.bind(s);
                this.removeAllListeners = s.removeAllListeners.bind(s);
                this.setTimeout = s.setTimeout;
                this.connect = s.connect;
                this.destroy = s.destroy;
            }
        },
    },
}));

const { checkTcp } = await import('../src/checks/tcp.js');

// The check now runs an async resolve/pin step before creating the socket, so we
// must wait until connect() has been called before emitting socket events.
async function emitWhenConnected(event, arg) {
    await vi.waitFor(() => {
        if (!mockSocket || mockSocket.connect.mock.calls.length === 0) {
            throw new Error('socket not connected yet');
        }
    });
    mockSocket.emit(event, arg);
}

describe('checkTcp', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const baseMonitor = {
        id: 1,
        url: 'https://example.com:443',
        timeout: 10,
        success_criteria: { max_response_time: 30000 },
    };

    it('returns success on connect and reports the resolved IP/family', async () => {
        const promise = checkTcp(baseMonitor);
        await emitWhenConnected('connect');
        const result = await promise;
        expect(result.is_success).toBe(true);
        expect(result.monitor_id).toBe(1);
        expect(result.response_time_ms).toBeTypeOf('number');
        expect(result.resolved_ip).toBe('93.184.216.34');
        expect(result.family).toBe('ipv4');
    });

    it('returns timeout error on socket timeout', async () => {
        const promise = checkTcp(baseMonitor);
        await emitWhenConnected('timeout');
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('timeout');
    });

    it('returns connection error on ECONNREFUSED', async () => {
        const promise = checkTcp(baseMonitor);
        const err = new Error('Connection refused');
        err.code = 'ECONNREFUSED';
        await emitWhenConnected('error', err);
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection');
        expect(result.error_message).toContain('Connection refused');
    });

    it('returns dns error on ENOTFOUND', async () => {
        const promise = checkTcp(baseMonitor);
        const err = new Error('Not found');
        err.code = 'ENOTFOUND';
        await emitWhenConnected('error', err);
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns');
    });

    it('returns connection_reset on ECONNRESET', async () => {
        const promise = checkTcp(baseMonitor);
        const err = new Error('Reset');
        err.code = 'ECONNRESET';
        await emitWhenConnected('error', err);
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection_reset');
    });

    it('returns host_unreachable on EHOSTUNREACH', async () => {
        const promise = checkTcp(baseMonitor);
        const err = new Error('Unreachable');
        err.code = 'EHOSTUNREACH';
        await emitWhenConnected('error', err);
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('host_unreachable');
    });

    it('returns network_unreachable on ENETUNREACH', async () => {
        const promise = checkTcp(baseMonitor);
        const err = new Error('Network unreachable');
        err.code = 'ENETUNREACH';
        await emitWhenConnected('error', err);
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('network_unreachable');
    });

    it('returns unknown error for unrecognized codes', async () => {
        const promise = checkTcp(baseMonitor);
        const err = new Error('Something weird');
        err.code = 'EWHATEVER';
        await emitWhenConnected('error', err);
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('unknown');
    });

    it('succeeds on connect regardless of how slow it was', async () => {
        const promise = checkTcp({ ...baseMonitor });
        await emitWhenConnected('connect');
        const result = await promise;
        expect(result.is_success).toBe(true);
        expect(result.error_type).toBeNull();
    });

    it('extracts host from plain hostname', async () => {
        const promise = checkTcp({ ...baseMonitor, url: 'myserver', port: 22 });
        await emitWhenConnected('connect');
        const result = await promise;
        expect(result.is_success).toBe(true);
    });
});
