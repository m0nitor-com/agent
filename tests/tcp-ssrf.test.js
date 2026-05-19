import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/lib/config.js', () => ({
    config: { ALLOW_PRIVATE_TARGETS: false },
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

describe('checkTcp — SSRF mitigation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('blocks a private IP literal target before opening a socket', async () => {
        const result = await checkTcp({
            id: 42,
            url: '10.0.0.5',
            port: 22,
            timeout: 5,
            success_criteria: { max_response_time: 30000 },
        });
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('blocked_private_target');
    });

    it('bypasses SSRF guard when monitor.allow_private_target=true', async () => {
        const promise = checkTcp({
            id: 43,
            url: '10.0.0.5',
            port: 22,
            timeout: 5,
            allow_private_target: true,
            success_criteria: { max_response_time: 30000 },
        });
        process.nextTick(() => mockSocket.emit('connect'));
        const result = await promise;
        expect(result.is_success).toBe(true);
    });
});
