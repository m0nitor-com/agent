import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config and logger before importing ApiClient
vi.mock('../src/lib/config.js', () => ({
    config: { SKIP_SSL_VERIFY: false },
}));
vi.mock('../src/lib/logger.js', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { default: ApiClient } = await import('../src/lib/api.js');
const { buildHealthHeader } = await import('../src/lib/health-header.js');

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

        it('never cuts an oversized health payload into invalid data', async () => {
            client.client.get = vi.fn().mockResolvedValue({ data: { monitors: [] } });
            const health = {
                status: 'ok',
                version: '2.9.0',
                contract_version: 3,
                schedule: { pending: 3, started: 9, start_delay_ms: { p50: 1, p95: 2, p99: 3, samples: 4 } },
                report_coalescer: { blob: 'c'.repeat(4000) },
                budgets: { blob: 'b'.repeat(4000) },
                governor: { paused: false, saturated: false, reduction_steps: 0, effective: { total: 4 }, blob: 'g'.repeat(2000) },
                egress: { ipv4: '1.2.3.4' },
                memory: { rss_bytes: 1234 },
                event_loop: { mean_delay_ms: 1 },
                push: { state: 'subscribed', last_close: { code: 1006, reason: 'r'.repeat(80), age_s: 5 } },
            };

            await client.getChecks({ health });
            const header = client.client.get.mock.calls[0][1].headers['X-Agent-Health'];
            expect(header.length).toBeLessThanOrEqual(6000);
            const decoded = JSON.parse(Buffer.from(header, 'base64url').toString());
            expect(decoded).toMatchObject({
                status: 'ok',
                version: '2.9.0',
                contract_version: 3,
                push: { state: 'subscribed' },
                memory: { rss_bytes: 1234 },
                event_loop: { mean_delay_ms: 1 },
            });
            expect(decoded.report_coalescer).toBeUndefined();
            expect(decoded.budgets).toBeUndefined();
        });

        it('drops optional parts in order and keeps what still fits', () => {
            const health = {
                status: 'ok',
                report_coalescer: { blob: 'c'.repeat(300) },
                budgets: { total: 4 },
                push: { state: 'subscribed', last_close: { code: 1 }, wake_delay_ms: { n: 1 }, rtt_ms: { n: 1 } },
            };
            const full = Buffer.from(JSON.stringify(health)).toString('base64url');
            const withoutCoalescer = Buffer.from(JSON.stringify({ ...health, report_coalescer: undefined })).toString('base64url');

            expect(buildHealthHeader(health, full.length)).toBe(full);
            const trimmed = JSON.parse(Buffer.from(buildHealthHeader(health, withoutCoalescer.length), 'base64url').toString());
            expect(trimmed.report_coalescer).toBeUndefined();
            expect(trimmed.budgets).toEqual({ total: 4 });
            expect(trimmed.push.last_close).toBeDefined();
        });

        it('sends no health header when even the core does not fit', () => {
            expect(buildHealthHeader({ status: 'ok', version: 'v'.repeat(500) }, 100)).toBeNull();
        });

        it('sends a fresh send time and its own timeout with every attempt', async () => {
            client.pollTimeoutMs = 20;
            client.baseDelay = 1;
            let now = 1_000_000;
            client.client.get = vi.fn((url, options) => new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })), { once: true });
            }));

            await expect(client.getChecks({ serverNow: () => (now += 5_000) })).rejects.toThrow('canceled');

            const [first, retry] = client.client.get.mock.calls.map((call) => call[1].headers);
            expect(first['X-Agent-Sent-At']).toBe('1005000');
            expect(retry['X-Agent-Sent-At']).toBe('1010000');
            expect(first['X-Agent-Poll-Timeout']).toBe('20');
        });

        it('leaves the send time out while the clock is not synced', async () => {
            client.client.get = vi.fn().mockResolvedValue({ data: { monitors: [] } });
            await client.getChecks({ serverNow: () => null });
            const headers = client.client.get.mock.calls[0][1].headers;
            expect(headers['X-Agent-Sent-At']).toBeUndefined();
            expect(headers['X-Agent-Poll-Timeout']).toBeUndefined();
        });

        it('gives every attempt its own id and names a given-up one on the retry', async () => {
            client.baseDelay = 1;
            client.client.get = vi.fn()
                .mockRejectedValueOnce(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
                .mockResolvedValue({ data: { monitors: [] } });

            await client.getChecks();

            const [lost, retry] = client.client.get.mock.calls.map((call) => call[1].headers);
            expect(lost['X-Agent-Poll-Id']).toMatch(/^[0-9a-f]{8}-[0-9a-z]+$/);
            expect(retry['X-Agent-Poll-Id']).not.toBe(lost['X-Agent-Poll-Id']);
            expect(retry['X-Agent-Abandoned-Polls']).toBe(lost['X-Agent-Poll-Id']);
            expect(lost['X-Agent-Abandoned-Polls']).toBeUndefined();
        });

        it('keeps naming a given-up attempt after a poll got through, until its leases have run out', async () => {
            client.baseDelay = 1;
            client.client.get = vi.fn()
                .mockRejectedValueOnce(new Error('socket hang up'))
                .mockRejectedValueOnce(new Error('socket hang up'))
                .mockImplementation(async () => ({ data: { monitors: [] } }));

            await expect(client.getChecks()).rejects.toThrow('socket hang up');
            await client.getChecks();
            await client.getChecks();

            const named = client.client.get.mock.calls.map((call) => call[1].headers['X-Agent-Abandoned-Polls']);
            expect(named[2].split(',')).toHaveLength(2);
            expect(named[3]).toBe(named[2]);

            client.abandonedPolls.forEach((poll) => { poll.at -= 6 * 60_000; });
            await client.getChecks();
            expect(client.client.get.mock.calls[4][1].headers['X-Agent-Abandoned-Polls']).toBeUndefined();
        });

        it('hands the answer its poll id and a monotonic round trip', async () => {
            client.client.get = vi.fn().mockResolvedValue({ data: { monitors: [] } });

            const data = await client.getChecks();

            expect(data.timing.pollId).toBe(client.client.get.mock.calls[0][1].headers['X-Agent-Poll-Id']);
            expect(data.timing.monotonicRttMs).toBeGreaterThanOrEqual(0);
            expect(Object.keys(data)).toEqual(['monitors']);
        });

        it('names no more given-up attempts than the console reads', () => {
            for (let i = 0; i < 25; i++) client.rememberAbandonedPoll(`a-${i}`);
            const named = client.namedAbandonedPolls();
            expect(named).toHaveLength(10);
            expect(named[9]).toBe('a-24');
        });

        it('announces a live push subscription', async () => {
            client.client.get = vi.fn().mockImplementation(async () => ({ data: { monitors: [] } }));
            await client.getChecks({ pushSubscribed: true });
            expect(client.client.get.mock.calls[0][1].headers['X-Agent-Push']).toBe('subscribed');

            await client.getChecks({ pushSubscribed: false });
            expect(client.client.get.mock.calls[1][1].headers['X-Agent-Push']).toBeUndefined();
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
