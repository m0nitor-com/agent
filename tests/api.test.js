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
        it('calls GET /workers/checks on its own connection with a short deadline', async () => {
            const data = { monitors: [] };
            client.client.get = vi.fn().mockResolvedValue({ data });
            const result = await client.getChecks();
            expect(client.client.get).toHaveBeenCalledWith('/workers/checks', expect.objectContaining({
                signal: expect.any(AbortSignal),
                timeout: 8000,
                httpAgent: client.pollHttpAgent,
                httpsAgent: client.pollHttpsAgent,
            }));
            expect(client.pollHttpsAgent).not.toBe(client.httpsAgent);
            expect(client.pollHttpsAgent.maxSockets).toBe(1);
            expect(result).toEqual(data);
        });

        it('aborts a hanging poll at the deadline and retries once on a new attempt', async () => {
            client.pollTimeoutMs = 20;
            client.baseDelay = 1;
            client.client.get = vi.fn((url, options) => new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })), { once: true });
            }));

            const started = Date.now();
            await expect(client.getChecks({ signal: new AbortController().signal })).rejects.toThrow('canceled');
            expect(client.client.get).toHaveBeenCalledTimes(2);
            expect(Date.now() - started).toBeLessThan(1000);
        });

        it('stops without retrying when the agent shuts down', async () => {
            const shutdown = new AbortController();
            client.baseDelay = 1;
            client.client.get = vi.fn((url, options) => new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }));

            const poll = client.getChecks({ signal: shutdown.signal });
            shutdown.abort();
            await expect(poll).rejects.toThrow('aborted');
            expect(client.client.get).toHaveBeenCalledTimes(1);
        });

        it('sends the health payload as a header', async () => {
            client.client.get = vi.fn().mockResolvedValue({ data: { monitors: [] } });
            await client.getChecks({ health: { status: 'ok' } });
            const headers = client.client.get.mock.calls[0][1].headers;
            expect(JSON.parse(Buffer.from(headers['X-Agent-Health'], 'base64url').toString())).toEqual({ status: 'ok' });
        });

        it('announces a live push subscription', async () => {
            client.client.get = vi.fn().mockImplementation(async () => ({ data: { monitors: [] } }));
            await client.getChecks({ pushSubscribed: true });
            expect(client.client.get.mock.calls[0][1].headers['X-Agent-Push']).toBe('subscribed');

            await client.getChecks({ pushSubscribed: false });
            expect(client.client.get.mock.calls[1][1].headers).toBeUndefined();
        });
    });

    describe('authorizePush', () => {
        it('posts socket and channel and returns the signature', async () => {
            client.client.post = vi.fn().mockResolvedValue({ data: { auth: 'key:sig' } });
            const result = await client.authorizePush({ socketId: '1.2', channel: 'private-probe-location.7' });
            expect(result).toEqual({ auth: 'key:sig' });
            expect(client.client.post).toHaveBeenCalledWith(
                '/workers/push/auth',
                { socket_id: '1.2', channel_name: 'private-probe-location.7' },
                expect.objectContaining({ timeout: 8000 }),
            );
        });

        it('does not retry', async () => {
            client.client.post = vi.fn().mockRejectedValue({ response: { status: 500 } });
            await expect(client.authorizePush({ socketId: '1.2', channel: 'c' })).rejects.toEqual({ response: { status: 500 } });
            expect(client.client.post).toHaveBeenCalledTimes(1);
        });
    });

    describe('getAdhocChecks', () => {
        it('uses the poll deadline', async () => {
            client.client.get = vi.fn().mockResolvedValue({ data: { monitors: [] } });
            await client.getAdhocChecks();
            expect(client.client.get).toHaveBeenCalledWith('/workers/adhoc', expect.objectContaining({ timeout: 8000 }));
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
