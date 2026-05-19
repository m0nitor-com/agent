import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// SSRF guard ON for this suite (ALLOW_PRIVATE_TARGETS=false).
vi.mock('../src/lib/config.js', () => ({
    config: { SKIP_SSL_VERIFY: false, ALLOW_PRIVATE_TARGETS: false },
}));

const mockAxios = vi.fn();
vi.mock('axios', () => ({ default: mockAxios }));

const { checkHttp } = await import('../src/checks/http.js');

describe('checkHttp — SSRF mitigation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const baseMonitor = {
        id: 99,
        type: 'http',
        url: 'http://10.0.0.1/',
        method: 'GET',
        timeout: 30,
        success_criteria: { status_codes: [200], max_response_time: 30000 },
    };

    it('blocks a private IP literal target (10.0.0.1) before making the request', async () => {
        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('blocked_private_target');
        expect(mockAxios).not.toHaveBeenCalled();
    });

    it('bypasses SSRF guard when monitor.allow_private_target=true', async () => {
        mockAxios.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'text/html' },
            data: 'ok',
            request: {},
            config: { url: baseMonitor.url },
        });

        const result = await checkHttp({ ...baseMonitor, allow_private_target: true });
        expect(result.is_success).toBe(true);
        expect(mockAxios).toHaveBeenCalledTimes(1);
    });

    it('maps EBLOCKED errors thrown by the guarded agent to blocked_private_target', async () => {
        // For a hostname (not an IP literal) the pre-flight may pass (or
        // succeed via real DNS), but the guarded agent then rejects. Simulate
        // by having axios throw EBLOCKED directly.
        const err = new Error('blocked_private_target:10.0.0.5');
        err.code = 'EBLOCKED';
        mockAxios.mockRejectedValue(err);

        // Use a public-looking literal so the pre-flight passes and we reach
        // the axios call, which throws our simulated EBLOCKED.
        const result = await checkHttp({
            ...baseMonitor,
            url: 'http://8.8.8.8/',
        });
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('blocked_private_target');
    });
});
