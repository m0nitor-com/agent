import { computeNextPollDelay } from './backoff.js';
import {
    PUSH_ACTIVITY_TIMEOUT_MS,
    PUSH_CLOSE_REASON_MAX_CHARS,
    PUSH_ERROR_MAX_CHARS,
    PUSH_LATENCY_WINDOW,
    PUSH_PONG_TIMEOUT_MS,
    PUSH_RECONNECT_BASE_MS,
    PUSH_RECONNECT_MAX_MS,
    PUSH_RTT_INTERVAL_MS,
    PUSH_UNAVAILABLE_RETRY_MS,
    PUSH_WAKE_DELAY_MAX_MS,
    PUSH_WORK_EVENT,
} from './constants.js';
import { LatencyWindow } from './latency-window.js';

const SOCKET_OPEN = 1;

// Answers of the auth request that will not change by retrying right away.
const UNAVAILABLE_AUTH_STATUSES = new Set([401, 403, 404, 410]);

// The server's activity_timeout is honoured within these bounds.
const MIN_ACTIVITY_TIMEOUT_MS = 5000;
const MAX_ACTIVITY_TIMEOUT_MS = 120_000;

const HOST_PATTERN = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:]+\])$/;
const SOCKET_ID_PATTERN = /^\d+\.\d+$/;

function parseData(data) {
    if (data && typeof data === 'object') return data;
    if (typeof data !== 'string') return {};
    try {
        const parsed = JSON.parse(data);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Listens on the console's Reverb server (Pusher protocol 7) for one thing:
 * "on-demand work is waiting at this location". The socket carries no check
 * data; a wake-up only makes the fast lane fetch /workers/adhoc right away.
 * Every failure falls back to polling, so a broken socket costs latency,
 * never checks.
 */
export class PushChannel {
    constructor({
        authorize,
        onWork,
        onStateChange = () => {},
        logger = null,
        version = '',
        WebSocketImpl = globalThis.WebSocket,
        rng = Math.random,
        serverNow = null,
        now = () => performance.now(),
    }) {
        this.authorize = authorize;
        this.onWork = onWork;
        this.onStateChange = onStateChange;
        this.logger = logger;
        this.version = version;
        this.WebSocketImpl = WebSocketImpl;
        this.rng = rng;
        // Console clock in epoch ms, or null while the clock is not synced.
        this.serverNow = serverNow;
        // Monotonic clock for durations and ages.
        this.now = now;
        this.target = null;
        this.signature = null;
        this.socket = null;
        this.state = 'idle';
        this.failures = 0;
        this.stopped = false;
        this.activityTimeoutMs = PUSH_ACTIVITY_TIMEOUT_MS;
        this.activityTimer = null;
        this.pongTimer = null;
        this.reconnectTimer = null;
        this.rttTimer = null;
        this.counters = { connects: 0, disconnects: 0, wakes: 0 };
        // The socket got its connection_established (it was really open).
        this.established = false;
        // Stamp of the one ping that waits for its pong (RTT and keepalive share it).
        this.pingSentAt = null;
        this.connectStartedAt = null;
        this.subscribedAt = null;
        this.subscribeMs = null;
        this.lastClose = null;
        this.lastError = null;
        this.lastWakeAt = null;
        this.rtt = new LatencyWindow(PUSH_LATENCY_WINDOW);
        this.lastRttMs = null;
        this.wakeDelay = new LatencyWindow(PUSH_LATENCY_WINDOW);
        this.lastWakeDelayMs = null;
    }

    static supported(WebSocketImpl = globalThis.WebSocket) {
        return typeof WebSocketImpl === 'function';
    }

    /**
     * Validates the push block of a checks poll. Anything unusable means "no
     * push": the agent keeps polling.
     */
    static normalize(push) {
        if (!push || typeof push !== 'object') return null;
        const { key, host, channel } = push;
        if (typeof key !== 'string' || key === '' || key.length > 200) return null;
        if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return null;
        if (typeof channel !== 'string' || !channel.startsWith('private-') || channel.length > 200) return null;

        const scheme = push.scheme === 'http' ? 'http' : 'https';
        const port = Number(push.port);
        const rawPath = typeof push.path === 'string' ? push.path.trim().replace(/\/+$/, '') : '';
        if (/[?#\s]/.test(rawPath)) return null;

        return {
            key,
            host,
            channel,
            scheme,
            port: Number.isInteger(port) && port > 0 && port < 65536 ? port : (scheme === 'https' ? 443 : 80),
            path: rawPath === '' || rawPath.startsWith('/') ? rawPath : `/${rawPath}`,
        };
    }

    get subscribed() {
        return this.state === 'subscribed';
    }

    get telemetry() {
        const now = this.now();
        const ageS = (at) => Math.max(0, Math.floor((now - at) / 1000));
        const rttSamples = this.rtt.values.length;
        const delaySamples = this.wakeDelay.values.length;
        const rtt = rttSamples > 0 ? this.rtt.percentiles() : null;
        const delay = delaySamples > 0 ? this.wakeDelay.percentiles() : null;
        return {
            state: this.state,
            connects: this.counters.connects,
            disconnects: this.counters.disconnects,
            wakes: this.counters.wakes,
            subscribed_for_s: this.subscribedAt === null ? null : ageS(this.subscribedAt),
            subscribe_ms: this.subscribeMs,
            rtt_ms: rtt && {
                last: Math.round(this.lastRttMs),
                p50: Math.round(rtt.p50),
                p95: Math.round(rtt.p95),
                max: Math.round(this.rtt.max()),
                n: rttSamples,
            },
            wake_delay_ms: delay && {
                last: Math.round(this.lastWakeDelayMs),
                p50: Math.round(delay.p50),
                p95: Math.round(delay.p95),
                n: delaySamples,
            },
            last_close: this.lastClose && {
                code: this.lastClose.code,
                reason: this.lastClose.reason,
                age_s: ageS(this.lastClose.at),
            },
            last_error: this.lastError,
            last_wake_age_s: this.lastWakeAt === null ? null : ageS(this.lastWakeAt),
        };
    }

    fail(reason) {
        this.lastError = String(reason).slice(0, PUSH_ERROR_MAX_CHARS);
    }

    /** Applies the push block of a checks poll. Unchanged settings are a no-op. */
    configure(push) {
        if (this.stopped) return;
        const target = PushChannel.normalize(push);
        const signature = target ? JSON.stringify(target) : null;
        if (signature === this.signature) return;

        this.signature = signature;
        this.target = target;
        this.failures = 0;
        this.clearReconnect();
        this.closeSocket();
        if (target) {
            this.connect();
        } else {
            this.setState('idle');
        }
    }

    stop() {
        this.stopped = true;
        this.target = null;
        this.clearReconnect();
        this.closeSocket();
        this.setState('idle');
    }

    url() {
        const { scheme, host, port, path, key } = this.target;
        const query = new URLSearchParams({
            protocol: '7',
            client: 'm0nitor-worker',
            version: String(this.version || ''),
            flash: 'false',
        });
        return `${scheme === 'https' ? 'wss' : 'ws'}://${host}:${port}${path}/app/${encodeURIComponent(key)}?${query}`;
    }

    connect() {
        this.reconnectTimer = null;
        if (this.stopped || !this.target) return;

        let socket;
        try {
            socket = new this.WebSocketImpl(this.url());
        } catch (error) {
            this.logger?.warn({ name: error?.name }, '[PUSH] Could not open the websocket');
            this.fail('socket_open');
            this.setState('disconnected');
            this.scheduleReconnect();
            return;
        }

        this.socket = socket;
        this.counters.connects++;
        this.connectStartedAt = this.now();
        this.setState('connecting');
        socket.addEventListener('message', (event) => {
            if (this.socket === socket) void this.handleMessage(event?.data);
        });
        socket.addEventListener('close', (event) => {
            if (this.socket !== socket) return;
            const code = Number(event?.code);
            this.lastClose = {
                code: Number.isInteger(code) ? code : null,
                reason: String(event?.reason ?? '').slice(0, PUSH_CLOSE_REASON_MAX_CHARS),
                at: this.now(),
            };
            this.drop();
        });
        // An error is always followed by a close event, which reconnects.
        socket.addEventListener('error', () => {
            if (this.socket === socket) this.fail('socket_error');
        });
    }

    async handleMessage(raw) {
        this.armActivity();

        let message;
        try {
            message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
        } catch {
            return;
        }
        if (!message || typeof message !== 'object') return;
        const data = parseData(message.data);

        switch (message.event) {
            case 'pusher:connection_established': {
                this.established = true;
                const timeoutMs = Number(data.activity_timeout) * 1000;
                if (timeoutMs > 0) {
                    this.activityTimeoutMs = Math.min(MAX_ACTIVITY_TIMEOUT_MS, Math.max(MIN_ACTIVITY_TIMEOUT_MS, timeoutMs));
                    this.armActivity();
                }
                await this.subscribe(String(data.socket_id ?? ''));
                return;
            }
            case 'pusher_internal:subscription_succeeded':
                if (message.channel === this.target?.channel) {
                    this.failures = 0;
                    if (this.connectStartedAt !== null) {
                        this.subscribeMs = Math.round(this.now() - this.connectStartedAt);
                    }
                    this.setState('subscribed');
                }
                return;
            case 'pusher:ping':
                this.send({ event: 'pusher:pong', data: {} });
                return;
            case 'pusher:pong':
                this.recordPong();
                return;
            case 'pusher:error':
                this.handleServerError(Number(data.code));
                return;
            case 'pusher:subscription_error':
                this.fail('subscription_error');
                this.logger?.warn({ status: Number(data.status) || undefined }, '[PUSH] Subscription refused, staying on polling');
                this.drop(PUSH_UNAVAILABLE_RETRY_MS);
                return;
            default:
                if (message.event === PUSH_WORK_EVENT && message.channel === this.target?.channel) {
                    this.counters.wakes++;
                    this.lastWakeAt = this.now();
                    this.recordWakeDelay(data.sent_at);
                    this.onWork();
                }
        }
    }

    /**
     * Pusher error ranges: 4000-4099 will fail again with the same settings,
     * 4100-4199 back off, 4200-4299 reconnect right away.
     */
    handleServerError(code) {
        if (!Number.isInteger(code)) return;
        this.fail(`pusher_error_${code}`);
        if (code >= 4000 && code < 4100) {
            this.logger?.warn({ code }, '[PUSH] Console refused the connection, staying on polling');
            this.drop(PUSH_UNAVAILABLE_RETRY_MS);
        } else if (code >= 4100 && code < 4200) {
            this.drop();
        } else if (code >= 4200 && code < 4300) {
            this.drop(PUSH_RECONNECT_BASE_MS);
        }
    }

    async subscribe(socketId) {
        const socket = this.socket;
        const target = this.target;
        if (!socket || !target || !SOCKET_ID_PATTERN.test(socketId)) {
            this.drop();
            return;
        }

        try {
            const result = await this.authorize({ socketId, channel: target.channel });
            if (this.socket !== socket) return;
            if (typeof result?.auth !== 'string' || result.auth === '') {
                throw new Error('Push auth answered without a signature');
            }
            this.send({ event: 'pusher:subscribe', data: { channel: target.channel, auth: result.auth } });
        } catch (error) {
            if (this.socket !== socket || this.stopped) return;
            const status = error?.response?.status;
            this.fail(Number.isInteger(status) ? `auth_${status}` : 'auth_network');
            if (UNAVAILABLE_AUTH_STATUSES.has(status)) {
                this.logger?.info({ status }, '[PUSH] Console refused push, staying on polling');
                this.drop(PUSH_UNAVAILABLE_RETRY_MS);
            } else {
                this.logger?.warn({
                    status,
                    code: typeof error?.code === 'string' ? error.code.slice(0, 40) : undefined,
                }, '[PUSH] Push auth failed');
                this.drop();
            }
        }
    }

    /**
     * Any message proves the link is alive. After a quiet activity timeout we
     * ping; without an answer in time the socket is dead and gets replaced.
     */
    armActivity() {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
        clearTimeout(this.activityTimer);
        this.activityTimer = null;
        if (!this.socket) return;

        this.activityTimer = setTimeout(() => {
            this.activityTimer = null;
            this.sendPing();
            this.pongTimer = setTimeout(() => {
                this.logger?.warn('[PUSH] No answer from the console, reconnecting');
                this.fail('pong_timeout');
                this.drop();
            }, PUSH_PONG_TIMEOUT_MS);
            this.pongTimer.unref?.();
        }, this.activityTimeoutMs);
        this.activityTimer.unref?.();
    }

    /**
     * Sends a ping and, unless one is already waiting, stamps it for the RTT.
     * A stamp older than the pong timeout belongs to a ping that got no
     * answer; it is replaced so a later pong is not measured against it.
     */
    sendPing() {
        const sent = this.send({ event: 'pusher:ping', data: {} });
        const now = this.now();
        if (sent && (this.pingSentAt === null || now - this.pingSentAt > PUSH_PONG_TIMEOUT_MS)) {
            this.pingSentAt = now;
        }
        return sent;
    }

    recordPong() {
        if (this.pingSentAt === null) return;
        const rttMs = Math.max(0, this.now() - this.pingSentAt);
        this.pingSentAt = null;
        this.lastRttMs = rttMs;
        this.rtt.push(rttMs);
    }

    /**
     * Console send time (epoch ms) to arrival. Old consoles send no sent_at,
     * and an unsynced clock has no server time to compare with.
     */
    recordWakeDelay(sentAt) {
        if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return;
        const serverNow = this.serverNow?.();
        if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return;
        const delayMs = Math.min(PUSH_WAKE_DELAY_MAX_MS, Math.max(0, serverNow - sentAt));
        this.lastWakeDelayMs = delayMs;
        this.wakeDelay.push(delayMs);
    }

    startRttTimer() {
        this.stopRttTimer();
        this.rttTimer = setInterval(() => this.sendPing(), PUSH_RTT_INTERVAL_MS);
        this.rttTimer.unref?.();
    }

    stopRttTimer() {
        clearInterval(this.rttTimer);
        this.rttTimer = null;
    }

    send(message) {
        if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
        try {
            this.socket.send(JSON.stringify(message));
            return true;
        } catch {
            return false;
        }
    }

    /** Closes the current socket and reconnects after a backoff or a fixed delay. */
    drop(retryAfterMs = null) {
        if (this.established) this.counters.disconnects++;
        this.closeSocket();
        if (this.stopped || !this.target) {
            this.setState('idle');
            return;
        }
        this.setState('disconnected');
        this.scheduleReconnect(retryAfterMs);
    }

    scheduleReconnect(retryAfterMs = null) {
        this.clearReconnect();
        this.failures++;
        const delay = Number.isFinite(retryAfterMs)
            ? retryAfterMs
            : Math.max(PUSH_RECONNECT_BASE_MS, computeNextPollDelay(PUSH_RECONNECT_BASE_MS, PUSH_RECONNECT_MAX_MS, this.failures, this.rng));
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
        this.reconnectTimer.unref?.();
    }

    clearReconnect() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    closeSocket() {
        clearTimeout(this.activityTimer);
        clearTimeout(this.pongTimer);
        this.stopRttTimer();
        this.activityTimer = null;
        this.pongTimer = null;
        this.pingSentAt = null;
        this.established = false;
        const socket = this.socket;
        this.socket = null;
        if (!socket) return;
        try {
            socket.close(1000);
        } catch {
            // already closing or closed
        }
    }

    setState(next) {
        if (this.state === next) return;
        const wasSubscribed = this.state === 'subscribed';
        this.state = next;
        const isSubscribed = next === 'subscribed';
        if (isSubscribed) {
            this.subscribedAt = this.now();
            this.startRttTimer();
        } else {
            this.subscribedAt = null;
            this.stopRttTimer();
        }
        if (wasSubscribed !== isSubscribed) this.onStateChange(isSubscribed);
    }
}
