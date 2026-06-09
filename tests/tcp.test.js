import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// SSRF guard OFF for this suite so existing tests run unimpeded.
vi.mock('../src/lib/config.js', () => ({
    config: { ALLOW_PRIVATE_TARGETS: true },
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

    it('returns success on connect', async () => {
        const promise = checkTcp(baseMonitor);
        process.nextTick(() => mockSocket.emit('connect'));
        const result = await promise;
        expect(result.is_success).toBe(true);
        expect(result.monitor_id).toBe(1);
        expect(result.response_time_ms).toBeTypeOf('number');
    });

    it('returns timeout error on socket timeout', async () => {
        const promise = checkTcp(baseMonitor);
        process.nextTick(() => mockSocket.emit('timeout'));
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('timeout');
    });

    it('returns connection error on ECONNREFUSED', async () => {
        const promise = checkTcp(baseMonitor);
        process.nextTick(() => {
            const err = new Error('Connection refused');
            err.code = 'ECONNREFUSED';
            mockSocket.emit('error', err);
        });
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection');
        expect(result.error_message).toContain('Connection refused');
    });

    it('returns dns error on ENOTFOUND', async () => {
        const promise = checkTcp(baseMonitor);
        process.nextTick(() => {
            const err = new Error('Not found');
            err.code = 'ENOTFOUND';
            mockSocket.emit('error', err);
        });
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns');
    });

    it('returns connection_reset on ECONNRESET', async () => {
        const promise = checkTcp(baseMonitor);
        process.nextTick(() => {
            const err = new Error('Reset');
            err.code = 'ECONNRESET';
            mockSocket.emit('error', err);
        });
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection_reset');
    });

    it('returns host_unreachable on EHOSTUNREACH', async () => {
        const promise = checkTcp(baseMonitor);
        process.nextTick(() => {
            const err = new Error('Unreachable');
            err.code = 'EHOSTUNREACH';
            mockSocket.emit('error', err);
        });
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('host_unreachable');
    });

    it('returns network_unreachable on ENETUNREACH', async () => {
        const promise = checkTcp(baseMonitor);
        process.nextTick(() => {
            const err = new Error('Network unreachable');
            err.code = 'ENETUNREACH';
            mockSocket.emit('error', err);
        });
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('network_unreachable');
    });

    it('returns unknown error for unrecognized codes', async () => {
        const promise = checkTcp(baseMonitor);
        process.nextTick(() => {
            const err = new Error('Something weird');
            err.code = 'EWHATEVER';
            mockSocket.emit('error', err);
        });
        const result = await promise;
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('unknown');
    });

    it('succeeds on connect regardless of how slow it was', async () => {
        const promise = checkTcp({ ...baseMonitor });
        process.nextTick(() => mockSocket.emit('connect'));
        const result = await promise;
        expect(result.is_success).toBe(true);
        expect(result.error_type).toBeNull();
    });

    it('extracts host from plain hostname', async () => {
        const promise = checkTcp({ ...baseMonitor, url: 'myserver', port: 22 });
        process.nextTick(() => mockSocket.emit('connect'));
        const result = await promise;
        expect(result.is_success).toBe(true);
    });
});
