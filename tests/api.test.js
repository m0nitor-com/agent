import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config and logger before importing ApiClient
vi.mock('../src/lib/config.js', () => ({
    config: { SKIP_SSL_VERIFY: false },
}));
vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { default: ApiClient } = await import('../src/lib/api.js');

describe('ApiClient', () => {
    let client;

    beforeEach(() => {
        client = new ApiClient('https://api.example.com/', 'test-token');
    });

    it('strips trailing slash from baseUrl', () => {
        expect(client.baseUrl).toBe('https://api.example.com');
    });

    it('stores token and version', () => {
        expect(client.token).toBe('test-token');
        expect(client.version).toBeDefined();
    });

    it('creates axios client with correct headers', () => {
        const headers = client.client.defaults.headers;
        expect(headers['Authorization']).toBe('Bearer test-token');
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['Accept']).toBe('application/json');
        expect(headers['X-Worker-Version']).toBe(client.version);
    });

    describe('withRetry', () => {
        it('returns result on first success', async () => {
            const fn = vi.fn().mockResolvedValue('ok');
            const result = await client.withRetry(fn);
            expect(result).toBe('ok');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('retries on server error and succeeds', async () => {
            const fn = vi.fn()
                .mockRejectedValueOnce({ response: { status: 500 } })
                .mockResolvedValue('ok');
            client.baseDelay = 1; // speed up test
            const result = await client.withRetry(fn);
            expect(result).toBe('ok');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it('does not retry on 401', async () => {
            const error = { response: { status: 401 } };
            const fn = vi.fn().mockRejectedValue(error);
            await expect(client.withRetry(fn)).rejects.toEqual(error);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('does not retry on 403', async () => {
            const error = { response: { status: 403 } };
            const fn = vi.fn().mockRejectedValue(error);
            await expect(client.withRetry(fn)).rejects.toEqual(error);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('does not retry on 422', async () => {
            const error = { response: { status: 422 } };
            const fn = vi.fn().mockRejectedValue(error);
            await expect(client.withRetry(fn)).rejects.toEqual(error);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('throws after max retries', async () => {
            const error = new Error('server down');
            const fn = vi.fn().mockRejectedValue(error);
            client.baseDelay = 1;
            await expect(client.withRetry(fn)).rejects.toThrow('server down');
            expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
        });
    });

    describe('getChecks', () => {
        it('calls GET /workers/checks', async () => {
            const data = { monitors: [] };
            client.client.get = vi.fn().mockResolvedValue({ data });
            const result = await client.getChecks();
            expect(client.client.get).toHaveBeenCalledWith('/workers/checks');
            expect(result).toEqual(data);
        });
    });

    describe('reportCheck', () => {
        it('calls POST /workers/report', async () => {
            const payload = { monitor_id: 1, is_success: true };
            client.client.post = vi.fn().mockResolvedValue({ data: { ok: true } });
            const result = await client.reportCheck(payload);
            expect(client.client.post).toHaveBeenCalledWith('/workers/report', payload);
            expect(result).toEqual({ ok: true });
        });
    });

    describe('reportBatch', () => {
        it('calls POST /workers/report-batch with a reports wrapper', async () => {
            const reports = [{ monitor_id: 1, is_success: true }, { monitor_id: 2, is_success: false }];
            client.client.post = vi.fn().mockResolvedValue({ data: { success: true } });
            const result = await client.reportBatch(reports);
            expect(client.client.post).toHaveBeenCalledWith('/workers/report-batch', { reports });
            expect(result).toEqual({ success: true });
        });
    });
});
