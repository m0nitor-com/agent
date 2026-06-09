import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/lib/config.js', () => ({
    config: { ALLOW_PRIVATE_TARGETS: true },
}));

const mockProbe = vi.fn();
vi.mock('ping', () => ({
    default: {
        promise: { probe: mockProbe },
    },
}));

const { checkPing } = await import('../src/checks/ping.js');

describe('checkPing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const baseMonitor = {
        id: 1,
        url: 'https://example.com',
        timeout: 10,
        success_criteria: { max_response_time: 30000 },
    };

    it('returns success when host is alive', async () => {
        mockProbe.mockResolvedValue({
            alive: true,
            avg: '12.5',
            time: '13',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(true);
        expect(result.monitor_id).toBe(1);
        expect(result.response_time_ms).toBe(13); // Math.round(12.5) = 13
    });

    it('uses time when avg is NaN', async () => {
        mockProbe.mockResolvedValue({
            alive: true,
            avg: 'unknown',
            time: '25.3',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(true);
        expect(result.response_time_ms).toBe(25);
    });

    it('falls back to 0 when both avg and time are NaN', async () => {
        mockProbe.mockResolvedValue({
            alive: true,
            avg: 'unknown',
            time: 'unknown',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(true);
        expect(result.response_time_ms).toBe(0);
    });

    it('fails on response time exceeding limit', async () => {
        mockProbe.mockResolvedValue({
            alive: true,
            avg: '35000',
            time: '35000',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('response_time');
    });

    it('returns host_unreachable error', async () => {
        mockProbe.mockResolvedValue({
            alive: false,
            output: 'Destination Host Unreachable',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('host_unreachable');
    });

    it('returns timeout error', async () => {
        mockProbe.mockResolvedValue({
            alive: false,
            output: 'Request timed out',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('timeout');
    });

    it('returns dns error from ping output', async () => {
        mockProbe.mockResolvedValue({
            alive: false,
            output: 'could not find host',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns');
    });

    it('returns network_unreachable error', async () => {
        mockProbe.mockResolvedValue({
            alive: false,
            output: 'connect: network is unreachable',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('network_unreachable');
    });

    it('returns permission error when ICMP is not permitted', async () => {
        mockProbe.mockResolvedValue({
            alive: false,
            output: 'ping: permission denied (are you root?)',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('permission');
    });

    it('returns generic connection error for unknown output', async () => {
        mockProbe.mockResolvedValue({
            alive: false,
            output: 'some unknown failure',
        });

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection');
    });

    it('handles thrown error with ENOTFOUND', async () => {
        mockProbe.mockRejectedValue(new Error('ENOTFOUND'));

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns');
    });

    it('handles thrown generic error', async () => {
        mockProbe.mockRejectedValue(new Error('Something broke'));

        const result = await checkPing(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('unknown');
        expect(result.error_message).toBe('Something broke');
    });

    it('extracts hostname from plain string', async () => {
        mockProbe.mockResolvedValue({ alive: true, avg: '10', time: '10' });

        await checkPing({ ...baseMonitor, url: '192.168.1.1' });
        expect(mockProbe).toHaveBeenCalledWith('192.168.1.1', expect.any(Object));
    });
});
