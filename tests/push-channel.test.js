import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushChannel } from '../src/lib/push-channel.js';
import {
    PUSH_PONG_TIMEOUT_MS,
    PUSH_RTT_INTERVAL_MS,
    PUSH_UNAVAILABLE_RETRY_MS,
    PUSH_WAKE_DELAY_MAX_MS,
} from '../src/lib/constants.js';

class FakeSocket {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.sent = [];
        this.listeners = {};
        this.closed = false;
        FakeSocket.instances.push(this);
    }

    addEventListener(type, listener) {
        (this.listeners[type] ||= []).push(listener);
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    close() {
        this.closed = true;
        this.readyState = 3;
    }

    emit(type, payload = {}) {
        for (const listener of this.listeners[type] || []) listener(payload);
    }

    receive(event, data = {}, channel = undefined) {
        const message = { event, data: JSON.stringify(data) };
        if (channel) message.channel = channel;
        this.emit('message', { data: JSON.stringify(message) });
    }

    serverClose() {
        this.readyState = 3;
        this.emit('close');
    }
}

const CONFIG = {
    key: 'app-key',
    host: 'm0nitor.test',
    port: 443,
    scheme: 'https',
    path: '/ws',
    channel: 'private-probe-location.7',
};

function createChannel(overrides = {}) {
    const onWork = vi.fn();
    const onStateChange = vi.fn();
    const authorize = vi.fn().mockResolvedValue({ auth: 'app-key:signature' });
    const channel = new PushChannel({
        authorize,
        onWork,
        onStateChange,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        version: '2.8.0',
        WebSocketImpl: FakeSocket,
        rng: () => 0.5,
        ...overrides,
    });
    return { channel, onWork, onStateChange, authorize: overrides.authorize || authorize };
}

async function establish(socket, socketId = '123.456') {
    socket.receive('pusher:connection_established', { socket_id: socketId, activity_timeout: 30 });
    await vi.waitFor(() => expect(socket.sent.some((m) => m.event === 'pusher:subscribe')).toBe(true));
}

afterEach(() => {
    FakeSocket.instances = [];
    vi.useRealTimers();
});

describe('PushChannel', () => {
    it('connects to the console path and subscribes with a signed channel', async () => {
        const { channel, authorize, onStateChange } = createChannel();
        channel.configure(CONFIG);

        const socket = FakeSocket.instances[0];
        expect(socket.url).toBe('wss://m0nitor.test:443/ws/app/app-key?protocol=7&client=m0nitor-worker&version=2.8.0&flash=false');

        await establish(socket);
        expect(authorize).toHaveBeenCalledWith({ socketId: '123.456', channel: CONFIG.channel });
        expect(socket.sent).toContainEqual({
            event: 'pusher:subscribe',
            data: { channel: CONFIG.channel, auth: 'app-key:signature' },
        });
        expect(channel.subscribed).toBe(false);

        socket.receive('pusher_internal:subscription_succeeded', {}, CONFIG.channel);
        expect(channel.subscribed).toBe(true);
        expect(onStateChange).toHaveBeenCalledWith(true);
        channel.stop();
    });

    it('wakes only for the work event on its own channel', async () => {
        const { channel, onWork } = createChannel();
        channel.configure(CONFIG);
        const socket = FakeSocket.instances[0];
        await establish(socket);
        socket.receive('pusher_internal:subscription_succeeded', {}, CONFIG.channel);

        socket.receive('work.available', [], CONFIG.channel);
        socket.receive('work.available', [], 'private-probe-location.8');
        socket.receive('live.update', {}, CONFIG.channel);

        expect(onWork).toHaveBeenCalledTimes(1);
        expect(channel.telemetry.wakes).toBe(1);
        channel.stop();
    });

    it('answers server pings', () => {
        const { channel } = createChannel();
        channel.configure(CONFIG);
        const socket = FakeSocket.instances[0];

        socket.receive('pusher:ping');
        expect(socket.sent).toContainEqual({ event: 'pusher:pong', data: {} });
        channel.stop();
    });

    it('reconnects with backoff after the server closes the socket', async () => {
        vi.useFakeTimers();
        const { channel, onStateChange } = createChannel();
        channel.configure(CONFIG);
        const first = FakeSocket.instances[0];
        first.receive('pusher:connection_established', { socket_id: '1.2', activity_timeout: 30 });
        await vi.advanceTimersByTimeAsync(0);
        first.receive('pusher_internal:subscription_succeeded', {}, CONFIG.channel);

        first.serverClose();
        expect(channel.state).toBe('disconnected');
        expect(onStateChange).toHaveBeenLastCalledWith(false);
        expect(FakeSocket.instances).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(FakeSocket.instances).toHaveLength(2);
        channel.stop();
    });

    it('stays on polling for a while when the console refuses push', async () => {
        vi.useFakeTimers();
        const refused = Object.assign(new Error('Not found'), { response: { status: 404 } });
        const { channel } = createChannel({ authorize: vi.fn().mockRejectedValue(refused) });
        channel.configure(CONFIG);
        FakeSocket.instances[0].receive('pusher:connection_established', { socket_id: '1.2' });
        await vi.advanceTimersByTimeAsync(0);

        expect(FakeSocket.instances[0].closed).toBe(true);
        expect(channel.subscribed).toBe(false);

        await vi.advanceTimersByTimeAsync(PUSH_UNAVAILABLE_RETRY_MS - 1);
        expect(FakeSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeSocket.instances).toHaveLength(2);
        channel.stop();
    });

    it('treats a 4000-range server error as refused', async () => {
        vi.useFakeTimers();
        const { channel } = createChannel();
        channel.configure(CONFIG);
        FakeSocket.instances[0].receive('pusher:error', { code: 4001, message: 'Application does not exist' });

        expect(FakeSocket.instances[0].closed).toBe(true);
        await vi.advanceTimersByTimeAsync(PUSH_UNAVAILABLE_RETRY_MS - 1);
        expect(FakeSocket.instances).toHaveLength(1);
        channel.stop();
    });

    it('pings after a quiet activity timeout and replaces a dead socket', async () => {
        vi.useFakeTimers();
        const { channel } = createChannel();
        channel.configure(CONFIG);
        const socket = FakeSocket.instances[0];
        socket.receive('pusher:connection_established', { socket_id: '1.2', activity_timeout: 30 });
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(socket.sent).toContainEqual({ event: 'pusher:ping', data: {} });

        await vi.advanceTimersByTimeAsync(PUSH_PONG_TIMEOUT_MS);
        expect(socket.closed).toBe(true);
        expect(channel.state).toBe('disconnected');
        channel.stop();
    });

    it('a pong keeps the socket', async () => {
        vi.useFakeTimers();
        const { channel } = createChannel();
        channel.configure(CONFIG);
        const socket = FakeSocket.instances[0];
        socket.receive('pusher:connection_established', { socket_id: '1.2', activity_timeout: 30 });
        await vi.advanceTimersByTimeAsync(30_000);
        socket.receive('pusher:pong');

        await vi.advanceTimersByTimeAsync(PUSH_PONG_TIMEOUT_MS);
        expect(socket.closed).toBe(false);
        channel.stop();
    });

    it('ignores unchanged settings and closes when push goes away', () => {
        const { channel } = createChannel();
        channel.configure(CONFIG);
        channel.configure({ ...CONFIG });
        expect(FakeSocket.instances).toHaveLength(1);

        channel.configure({ ...CONFIG, channel: 'private-probe-location.9' });
        expect(FakeSocket.instances).toHaveLength(2);
        expect(FakeSocket.instances[0].closed).toBe(true);

        channel.configure(null);
        expect(FakeSocket.instances[1].closed).toBe(true);
        expect(channel.state).toBe('idle');
        channel.stop();
    });

    it('rejects unusable settings', () => {
        expect(PushChannel.normalize(null)).toBeNull();
        expect(PushChannel.normalize({ ...CONFIG, key: '' })).toBeNull();
        expect(PushChannel.normalize({ ...CONFIG, host: 'evil.test/x?' })).toBeNull();
        expect(PushChannel.normalize({ ...CONFIG, channel: 'probe-location.7' })).toBeNull();
        expect(PushChannel.normalize({ ...CONFIG, path: '/ws?x=1' })).toBeNull();
        expect(PushChannel.normalize({ ...CONFIG, port: 'x', path: 'ws/' })).toMatchObject({ port: 443, path: '/ws' });
        expect(PushChannel.normalize({ ...CONFIG, scheme: 'http', port: undefined })).toMatchObject({ scheme: 'http', port: 80 });
    });

    it('does nothing after stop', () => {
        const { channel } = createChannel();
        channel.stop();
        channel.configure(CONFIG);
        expect(FakeSocket.instances).toHaveLength(0);
    });
});

describe('PushChannel telemetry', () => {
    function clocked(overrides = {}) {
        const time = { ms: 1000 };
        const created = createChannel({ now: () => time.ms, ...overrides });
        return { ...created, time };
    }

    async function subscribe(channel, time, handshakeMs = 0) {
        channel.configure(CONFIG);
        const socket = FakeSocket.instances.at(-1);
        await establish(socket);
        time.ms += handshakeMs;
        socket.receive('pusher_internal:subscription_succeeded', {}, CONFIG.channel);
        return socket;
    }

    it('starts with an empty, fully shaped snapshot', () => {
        const { channel } = clocked();
        expect(channel.telemetry).toEqual({
            state: 'idle',
            connects: 0,
            disconnects: 0,
            wakes: 0,
            subscribed_for_s: null,
            subscribe_ms: null,
            rtt_ms: null,
            wake_delay_ms: null,
            last_close: null,
            last_error: null,
            last_wake_age_s: null,
        });
    });

    it('measures the round trip of a ping while subscribed', async () => {
        vi.useFakeTimers();
        const { channel, time } = clocked();
        channel.configure(CONFIG);
        const socket = FakeSocket.instances[0];
        socket.receive('pusher:connection_established', { socket_id: '1.2', activity_timeout: 120 });
        await vi.advanceTimersByTimeAsync(0);
        socket.receive('pusher_internal:subscription_succeeded', {}, CONFIG.channel);

        await vi.advanceTimersByTimeAsync(PUSH_RTT_INTERVAL_MS);
        expect(socket.sent.filter((m) => m.event === 'pusher:ping')).toHaveLength(1);
        time.ms += 42;
        socket.receive('pusher:pong');
        expect(channel.telemetry.rtt_ms).toEqual({ last: 42, p50: 42, p95: 42, max: 42, n: 1 });

        await vi.advanceTimersByTimeAsync(PUSH_RTT_INTERVAL_MS);
        time.ms += 100;
        socket.receive('pusher:pong');
        expect(channel.telemetry.rtt_ms).toEqual({ last: 100, p50: 42, p95: 100, max: 100, n: 2 });
        channel.stop();
    });

    it('ignores a pong without a ping in flight', async () => {
        const { channel, time } = clocked();
        const socket = await subscribe(channel, time);
        socket.receive('pusher:pong');
        expect(channel.telemetry.rtt_ms).toBeNull();
        channel.stop();
    });

    it('shares the in-flight stamp with the keepalive ping', async () => {
        vi.useFakeTimers();
        const { channel, time } = clocked();
        channel.configure(CONFIG);
        const socket = FakeSocket.instances[0];
        socket.receive('pusher:connection_established', { socket_id: '1.2', activity_timeout: 30 });
        await vi.advanceTimersByTimeAsync(0);
        socket.receive('pusher_internal:subscription_succeeded', {}, CONFIG.channel);

        await vi.advanceTimersByTimeAsync(PUSH_RTT_INTERVAL_MS);
        time.ms += 10;
        await vi.advanceTimersByTimeAsync(0);
        expect(socket.sent.filter((m) => m.event === 'pusher:ping')).toHaveLength(2);

        time.ms += 15;
        socket.receive('pusher:pong');
        expect(channel.telemetry.rtt_ms).toMatchObject({ last: 25, n: 1 });
        socket.receive('pusher:pong');
        expect(channel.telemetry.rtt_ms.n).toBe(1);
        channel.stop();
    });

    it('stamps a keepalive ping only once while another is in flight', async () => {
        const { channel, time } = clocked();
        const socket = await subscribe(channel, time);

        channel.sendPing();
        const firstStamp = channel.pingSentAt;
        time.ms += 500;
        channel.sendPing();
        expect(channel.pingSentAt).toBe(firstStamp);
        expect(socket.sent.filter((m) => m.event === 'pusher:ping')).toHaveLength(2);

        socket.receive('pusher:pong');
        expect(channel.telemetry.rtt_ms).toMatchObject({ last: 500, n: 1 });
        channel.stop();
    });

    it('restamps a ping whose pong never came', async () => {
        const { channel, time } = clocked();
        const socket = await subscribe(channel, time);

        channel.sendPing();
        time.ms += PUSH_PONG_TIMEOUT_MS + 1;
        channel.sendPing();
        time.ms += 30;
        socket.receive('pusher:pong');
        expect(channel.telemetry.rtt_ms).toMatchObject({ last: 30, n: 1 });
        channel.stop();
    });

    it('still reconnects when a ping stays unanswered', async () => {
        vi.useFakeTimers();
        const { channel, time } = clocked();
        const socket = await subscribe(channel, time);

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(PUSH_PONG_TIMEOUT_MS);
        expect(socket.closed).toBe(true);
        expect(channel.state).toBe('disconnected');
        expect(channel.telemetry).toMatchObject({ disconnects: 1, last_error: 'pong_timeout', rtt_ms: null });
        expect(channel.pingSentAt).toBeNull();
        channel.stop();
    });

    it('tracks subscribe time, subscription age and disconnects', async () => {
        vi.useFakeTimers();
        const { channel, time } = clocked();
        const socket = await subscribe(channel, time, 85);
        expect(channel.telemetry).toMatchObject({ subscribe_ms: 85, subscribed_for_s: 0, connects: 1 });

        time.ms += 125_900;
        expect(channel.telemetry.subscribed_for_s).toBe(125);

        socket.serverClose();
        expect(channel.telemetry).toMatchObject({ disconnects: 1, subscribed_for_s: null, state: 'disconnected' });
        channel.stop();
    });

    it('does not count a socket that never opened as a disconnect', () => {
        const { channel } = clocked();
        channel.configure(CONFIG);
        FakeSocket.instances[0].serverClose();
        expect(channel.telemetry.disconnects).toBe(0);
        channel.stop();
    });

    it('records the close code and a trimmed reason', async () => {
        vi.useFakeTimers();
        const { channel, time } = clocked();
        const socket = await subscribe(channel, time);

        time.ms += 7500;
        socket.readyState = 3;
        socket.emit('close', { code: 4201, reason: 'x'.repeat(200) });
        time.ms += 3000;
        expect(channel.telemetry.last_close).toEqual({ code: 4201, reason: 'x'.repeat(80), age_s: 3 });
        channel.stop();
    });

    it('keeps a close without details as null code and empty reason', () => {
        const { channel } = clocked();
        channel.configure(CONFIG);
        FakeSocket.instances[0].serverClose();
        expect(channel.telemetry.last_close).toEqual({ code: null, reason: '', age_s: 0 });
        channel.stop();
    });

    it('names the failure of an auth request', async () => {
        vi.useFakeTimers();
        const refused = Object.assign(new Error('Forbidden'), { response: { status: 403 } });
        const forbidden = clocked({ authorize: vi.fn().mockRejectedValue(refused) });
        forbidden.channel.configure(CONFIG);
        FakeSocket.instances[0].receive('pusher:connection_established', { socket_id: '1.2' });
        await vi.advanceTimersByTimeAsync(0);
        expect(forbidden.channel.telemetry.last_error).toBe('auth_403');
        forbidden.channel.stop();

        const down = clocked({ authorize: vi.fn().mockRejectedValue(new Error('socket hang up')) });
        down.channel.configure(CONFIG);
        FakeSocket.instances[1].receive('pusher:connection_established', { socket_id: '1.2' });
        await vi.advanceTimersByTimeAsync(0);
        expect(down.channel.telemetry.last_error).toBe('auth_network');
        down.channel.stop();
    });

    it('names server errors, refused subscriptions and socket errors', () => {
        vi.useFakeTimers();
        const { channel } = clocked();
        channel.configure(CONFIG);
        const socket = FakeSocket.instances[0];

        socket.emit('error');
        expect(channel.telemetry.last_error).toBe('socket_error');
        socket.receive('pusher:subscription_error', { status: 403 });
        expect(channel.telemetry.last_error).toBe('subscription_error');
        channel.stop();

        const other = clocked();
        other.channel.configure(CONFIG);
        FakeSocket.instances[1].receive('pusher:error', { code: 4201 });
        expect(other.channel.telemetry.last_error).toBe('pusher_error_4201');
        other.channel.stop();
    });

    it('measures the wake delivery delay against the console clock', async () => {
        const serverNow = vi.fn(() => 1_700_000_000_250);
        const { channel, onWork, time } = clocked({ serverNow });
        const socket = await subscribe(channel, time);

        socket.receive('work.available', { sent_at: 1_700_000_000_000 }, CONFIG.channel);
        time.ms += 12_000;
        expect(onWork).toHaveBeenCalledTimes(1);
        expect(channel.telemetry.wake_delay_ms).toEqual({ last: 250, p50: 250, p95: 250, n: 1 });
        expect(channel.telemetry.last_wake_age_s).toBe(12);
        channel.stop();
    });

    it('accepts sent_at as a JSON string and clamps the delay', async () => {
        let now = 1_700_000_000_100;
        const { channel, time } = clocked({ serverNow: () => now });
        const socket = await subscribe(channel, time);

        const message = (data) => socket.emit('message', {
            data: JSON.stringify({ event: 'work.available', channel: CONFIG.channel, data }),
        });
        message(JSON.stringify({ sent_at: 1_700_000_000_000 }));
        expect(channel.telemetry.wake_delay_ms.last).toBe(100);

        message(JSON.stringify({ sent_at: now + 5000 }));
        expect(channel.telemetry.wake_delay_ms.last).toBe(0);

        now += 10_000_000;
        message(JSON.stringify({ sent_at: 1_700_000_000_000 }));
        expect(channel.telemetry.wake_delay_ms).toMatchObject({ last: PUSH_WAKE_DELAY_MAX_MS, n: 3 });
        channel.stop();
    });

    it('skips the delay for old consoles and an unsynced clock', async () => {
        const unsynced = clocked({ serverNow: () => null });
        const socket = await subscribe(unsynced.channel, unsynced.time);
        socket.receive('work.available', { sent_at: 1_700_000_000_000 }, CONFIG.channel);
        expect(unsynced.channel.telemetry).toMatchObject({ wakes: 1, wake_delay_ms: null });
        unsynced.channel.stop();

        const old = clocked({ serverNow: () => 1_700_000_000_000 });
        const oldSocket = await subscribe(old.channel, old.time);
        oldSocket.receive('work.available', [], CONFIG.channel);
        oldSocket.receive('work.available', { sent_at: 'soon' }, CONFIG.channel);
        expect(old.channel.telemetry).toMatchObject({ wakes: 2, wake_delay_ms: null });
        expect(old.onWork).toHaveBeenCalledTimes(2);
        old.channel.stop();

        const bare = clocked();
        const bareSocket = await subscribe(bare.channel, bare.time);
        bareSocket.receive('work.available', { sent_at: 1 }, CONFIG.channel);
        expect(bare.channel.telemetry.wake_delay_ms).toBeNull();
        bare.channel.stop();
    });
});
