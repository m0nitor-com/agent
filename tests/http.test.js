import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/lib/config.js', () => ({
    config: { SKIP_SSL_VERIFY: false, ALLOW_PRIVATE_TARGETS: true },
}));

const mockAxios = vi.fn();
vi.mock('axios', () => ({ default: mockAxios }));

const { checkHttp } = await import('../src/checks/http.js');

describe('checkHttp', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const baseMonitor = {
        id: 1,
        type: 'http',
        url: 'https://example.com',
        method: 'GET',
        timeout: 30,
        success_criteria: {
            status_codes: [200],
            max_response_time: 30000,
        },
    };

    function mockResponse(overrides = {}) {
        return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            data: '<html>OK</html>',
            request: {},
            config: { url: 'https://example.com' },
            ...overrides,
        };
    }

    it('returns success for 200 response', async () => {
        mockAxios.mockResolvedValue(mockResponse());

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(true);
        expect(result.monitor_id).toBe(1);
        expect(result.status_code).toBe(200);
        expect(result.response_time_ms).toBeTypeOf('number');
    });

    it('fails on unexpected status code', async () => {
        mockAxios.mockResolvedValue(mockResponse({ status: 500 }));

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('status_code');
        expect(result.error_message).toContain('500');
    });

    it('uses default accepted codes when none specified', async () => {
        mockAxios.mockResolvedValue(mockResponse({ status: 201 }));

        const result = await checkHttp({
            ...baseMonitor,
            success_criteria: {},
        });
        expect(result.is_success).toBe(true);
    });

    it('succeeds on a slow but valid response', async () => {
        mockAxios.mockImplementation(() =>
            new Promise(resolve => setTimeout(() => resolve(mockResponse()), 50))
        );

        const result = await checkHttp({
            ...baseMonitor,
            success_criteria: { status_codes: [200] },
        });
        expect(result.is_success).toBe(true);
    });

    it('fails when keyword not found in response', async () => {
        mockAxios.mockResolvedValue(mockResponse({ data: 'Hello World' }));

        const result = await checkHttp({
            ...baseMonitor,
            success_criteria: {
                status_codes: [200],
                max_response_time: 30000,
                keywords: ['NotInResponse'],
            },
        });
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('keyword');
    });

    it('succeeds when keyword is found', async () => {
        mockAxios.mockResolvedValue(mockResponse({ data: 'Hello World' }));

        const result = await checkHttp({
            ...baseMonitor,
            success_criteria: {
                status_codes: [200],
                max_response_time: 30000,
                keywords: ['Hello'],
            },
        });
        expect(result.is_success).toBe(true);
    });

    it('handles header assertion - contains', async () => {
        mockAxios.mockResolvedValue(mockResponse({
            headers: { 'content-type': 'text/html; charset=utf-8' },
        }));

        const result = await checkHttp({
            ...baseMonitor,
            success_criteria: {
                status_codes: [200],
                max_response_time: 30000,
                header_assertions: [
                    { header: 'Content-Type', comparison: 'contains', value: 'text/html' },
                ],
            },
        });
        expect(result.is_success).toBe(true);
    });

    it('fails header assertion - eq mismatch', async () => {
        mockAxios.mockResolvedValue(mockResponse({
            headers: { 'content-type': 'text/html' },
        }));

        const result = await checkHttp({
            ...baseMonitor,
            success_criteria: {
                status_codes: [200],
                max_response_time: 30000,
                header_assertions: [
                    { header: 'Content-Type', comparison: 'eq', value: 'application/json' },
                ],
            },
        });
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('header');
    });

    it('handles header assertion - not_empty', async () => {
        mockAxios.mockResolvedValue(mockResponse({
            headers: { 'server': 'nginx' },
        }));

        const result = await checkHttp({
            ...baseMonitor,
            success_criteria: {
                status_codes: [200],
                max_response_time: 30000,
                header_assertions: [
                    { header: 'server', comparison: 'not_empty', value: '' },
                ],
            },
        });
        expect(result.is_success).toBe(true);
    });

    it('handles header assertion - empty', async () => {
        mockAxios.mockResolvedValue(mockResponse({
            headers: {},
        }));

        const result = await checkHttp({
            ...baseMonitor,
            success_criteria: {
                status_codes: [200],
                max_response_time: 30000,
                header_assertions: [
                    { header: 'x-custom', comparison: 'empty', value: '' },
                ],
            },
        });
        expect(result.is_success).toBe(true);
    });

    it('handles DNS error (ENOTFOUND)', async () => {
        const err = new Error('getaddrinfo ENOTFOUND example.com');
        err.code = 'ENOTFOUND';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns');
    });

    it('handles timeout error (ECONNABORTED)', async () => {
        const err = new Error('timeout of 30000ms exceeded');
        err.code = 'ECONNABORTED';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('timeout');
    });

    it('handles connection refused', async () => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection');
    });

    it('handles connection reset', async () => {
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('connection_reset');
    });

    it('handles SSL expired error', async () => {
        const err = new Error('certificate has expired');
        err.code = 'CERT_HAS_EXPIRED';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('ssl_expired');
    });

    it('handles self-signed cert error', async () => {
        const err = new Error('self signed certificate');
        err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('ssl_self_signed');
    });

    it('names an oversized header block instead of calling it unknown', async () => {
        const err = new Error('Parse Error: Header overflow');
        err.code = 'HPE_HEADER_OVERFLOW';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('header_overflow');
        expect(result.error_message).toMatch(/\d+ KB this agent can parse/);
    });

    it('reads the overflow through an axios wrapper that only carries a cause', async () => {
        const err = new Error('Parse Error: Header overflow');
        err.cause = { code: 'HPE_HEADER_OVERFLOW' };
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.error_type).toBe('header_overflow');
    });

    it('separates other parser aborts from an unknown failure', async () => {
        const err = new Error('Parse Error: Invalid header value char');
        err.code = 'HPE_INVALID_HEADER_TOKEN';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.error_type).toBe('malformed_response');
    });

    it('handles too many redirects', async () => {
        const err = new Error('maxRedirects exceeded');
        err.code = 'ERR_FR_TOO_MANY_REDIRECTS';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('too_many_redirects');
    });

    it('handles unknown error', async () => {
        mockAxios.mockRejectedValue(new Error('Something unexpected'));

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('unknown');
    });

    it('filters response headers to essential ones', async () => {
        mockAxios.mockResolvedValue(mockResponse({
            headers: {
                'content-type': 'text/html',
                'x-powered-by': 'Express',
                'x-custom-nonsense': 'should-be-filtered',
                'server': 'nginx',
            },
        }));

        const result = await checkHttp(baseMonitor);
        expect(result.response_headers).toHaveProperty('content-type');
        expect(result.response_headers).toHaveProperty('server');
        expect(result.response_headers).not.toHaveProperty('x-custom-nonsense');
    });

    it('sanitizes sensitive data in body preview', async () => {
        mockAxios.mockResolvedValue(mockResponse({
            data: '{"api_key": "sk_live_abcdefgh12345678"}',
        }));

        const result = await checkHttp(baseMonitor);
        expect(result.response_body_preview).toContain('[REDACTED]');
        expect(result.response_body_preview).not.toContain('sk_live_abcdefgh12345678');
    });

    it('sends POST body when method is POST', async () => {
        mockAxios.mockResolvedValue(mockResponse());

        await checkHttp({
            ...baseMonitor,
            method: 'POST',
            body: '{"key":"value"}',
        });

        const callConfig = mockAxios.mock.calls[0][0];
        expect(callConfig.method).toBe('POST');
        expect(callConfig.data).toBe('{"key":"value"}');
    });

    it('falls back to GET for invalid HTTP method', async () => {
        mockAxios.mockResolvedValue(mockResponse());

        await checkHttp({ ...baseMonitor, method: 'INVALID' });

        const callConfig = mockAxios.mock.calls[0][0];
        expect(callConfig.method).toBe('GET');
    });

    it('tracks redirect final URL in response headers', async () => {
        mockAxios.mockResolvedValue(mockResponse({
            request: { res: { responseUrl: 'https://www.example.com' } },
        }));

        const result = await checkHttp(baseMonitor);
        expect(result.response_headers._final_url).toBe('https://www.example.com');
    });

    it('handles object response data in body preview', async () => {
        mockAxios.mockResolvedValue(mockResponse({
            data: { status: 'ok', count: 42 },
        }));

        const result = await checkHttp(baseMonitor);
        expect(result.response_body_preview).toContain('ok');
        expect(result.response_body_preview).toContain('42');
    });

    it('handles temporary DNS failure (EAI_AGAIN)', async () => {
        const err = new Error('getaddrinfo EAI_AGAIN');
        err.code = 'EAI_AGAIN';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns_temporary');
    });

    it('handles SSL hostname mismatch', async () => {
        const err = new Error('Hostname/IP does not match certificate altname');
        err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
        mockAxios.mockRejectedValue(err);

        const result = await checkHttp(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('ssl_hostname');
    });

    function mockHttpsResponse(cert) {
        return mockResponse({
            request: {
                socket: {
                    getPeerCertificate: () => cert,
                },
            },
        });
    }

    const httpsMonitor = { ...baseMonitor, type: 'https' };

    it('emits backend-canonical ssl_info (expires_at, no valid_to/valid_from) on a successful HTTPS check', async () => {
        const validTo = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
        const validFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        mockAxios.mockResolvedValue(mockHttpsResponse({
            valid_to: validTo,
            valid_from: validFrom,
            issuer: { O: "Let's Encrypt", CN: 'R3' },
            subject: { CN: 'example.com' },
        }));

        const result = await checkHttp(httpsMonitor);
        expect(result.is_success).toBe(true);
        expect(result.ssl_info.expires_at).toBe(validTo);
        expect(result.ssl_info.days_remaining).toBeTypeOf('number');
        expect(result.ssl_info.days_remaining).toBeGreaterThan(80);
        expect(result.ssl_info.subject).toBe('example.com');
        expect(result.ssl_info.issuer).toBe("Let's Encrypt");
        expect(result.ssl_info).not.toHaveProperty('valid_to');
        expect(result.ssl_info).not.toHaveProperty('valid_from');
    });

    it('reports ssl_expiring when a valid cert is below the minimum days threshold', async () => {
        const validTo = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
        const validFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        mockAxios.mockResolvedValue(mockHttpsResponse({
            valid_to: validTo,
            valid_from: validFrom,
            issuer: { O: "Let's Encrypt" },
            subject: { CN: 'example.com' },
        }));

        const result = await checkHttp(httpsMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('ssl_expiring');
        expect(result.error_message).toContain('expires in');
        expect(result.ssl_info.expires_at).toBe(validTo);
    });

    it('reports ssl_expired when the cert end date is in the past (success-path date check)', async () => {
        const validTo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        const validFrom = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
        mockAxios.mockResolvedValue(mockHttpsResponse({
            valid_to: validTo,
            valid_from: validFrom,
            issuer: { O: "Let's Encrypt" },
            subject: { CN: 'example.com' },
        }));

        const result = await checkHttp(httpsMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('ssl_expired');
        expect(result.error_message).toBe('SSL certificate has expired');
    });
});
