import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushChannel } from '../src/lib/push-channel.js';
import {
    PUSH_PONG_TIMEOUT_MS,
    PUSH_UNAVAILABLE_RETRY_MS,
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
