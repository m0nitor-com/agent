/**
 * Offset between this host's clock and the console clock.
 *
 * Each poll response carries server_time. The server stamped it somewhere
 * between sending the request and receiving the response, so the best guess
 * is the midpoint of the round trip. Samples are smoothed, and a sample from a
 * slow round trip counts less because its midpoint is less certain. With this
 * the agent schedules on console time even when the host clock is off, so NTP
 * on the host is not required.
 */
export class ClockSync {
    constructor({ alpha = 0.2, maxRttMs = 5000, now = () => Date.now() } = {}) {
        this.alpha = alpha;
        this.maxRttMs = maxRttMs;
        this.now = now;
        this.offsetMs = 0;
        this.samples = 0;
        this.lastRttMs = null;
    }

    /**
     * @param {number} serverTimeMs server_time from the response
     * @param {number} sentAtMs local time the request was sent
     * @param {number} receivedAtMs local time the response arrived
     */
    observe(serverTimeMs, sentAtMs, receivedAtMs) {
        if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return false;
        const rtt = receivedAtMs - sentAtMs;
        if (!(rtt >= 0) || rtt > this.maxRttMs) return false;

        const sample = serverTimeMs - (sentAtMs + rtt / 2);
        this.lastRttMs = rtt;
        if (this.samples === 0) {
            this.offsetMs = sample;
        } else {
            // A slow round trip has a wide error band: give it less weight.
            const weight = this.alpha / (1 + rtt / 250);
            this.offsetMs += (sample - this.offsetMs) * weight;
        }
        this.samples++;
        return true;
    }

    /** Current time on the console clock, in epoch ms. */
    serverNow() {
        return this.now() + this.offsetMs;
    }

    /** Local timer delay until a console timestamp. */
    delayUntil(serverTimeMs) {
        return serverTimeMs - this.serverNow();
    }

    get telemetry() {
        return {
            offset_ms: Math.round(this.offsetMs),
            samples: this.samples,
            last_rtt_ms: this.lastRttMs,
        };
    }
}
