/**
 * Offset between this host's clock and the console clock.
 *
 * Each poll response carries server_time. The server stamped it somewhere
 * between sending the request and receiving the response, so the best guess
 * is the midpoint of the round trip. Samples are smoothed, and a sample from a
 * slow round trip counts less because its midpoint is less certain. With this
 * the agent schedules on console time even when the host clock is off, so NTP
 * on the host is not required.
 *
 * When the host clock jumps (an NTP step, someone setting the time) the offset
 * no longer fits. The jump is not corrected by guesswork - a suspended host
 * looks the same to the monotonic clock and would be "corrected" wrongly -
 * instead the clock counts as unsynced until the next poll measures it anew.
 */
export class ClockSync {
    constructor({
        alpha = 0.2,
        maxRttMs = 5000,
        stepMs = 1000,
        now = () => Date.now(),
        monotonic = () => performance.now(),
    } = {}) {
        this.alpha = alpha;
        this.maxRttMs = maxRttMs;
        this.stepMs = stepMs;
        this.now = now;
        this.monotonic = monotonic;
        this.offsetMs = 0;
        this.samples = 0;
        this.lastRttMs = null;
        this.steps = 0;
        this.lastWallMs = null;
        this.lastMonotonicMs = null;
    }

    /**
     * True when the host clock moved by more than stepMs against the monotonic
     * clock since the last look. Resets the sync, so the next sample is taken
     * as is instead of being smoothed into an offset that no longer fits.
     */
    detectStep() {
        const wall = this.now();
        const mono = this.monotonic();
        const previousWall = this.lastWallMs;
        const previousMono = this.lastMonotonicMs;
        this.lastWallMs = wall;
        this.lastMonotonicMs = mono;
        if (previousWall === null) return false;

        const jump = (wall - previousWall) - (mono - previousMono);
        if (Math.abs(jump) <= this.stepMs) return false;

        this.samples = 0;
        this.steps++;
        return true;
    }

    /**
     * @param {number} serverTimeMs server_time from the response
     * @param {number} sentAtMs local time the request was sent
     * @param {number} receivedAtMs local time the response arrived
     */
    observe(serverTimeMs, sentAtMs, receivedAtMs, monotonicRttMs = receivedAtMs - sentAtMs) {
        // A jump during the request makes this round trip worthless as well.
        if (this.detectStep()) return false;
        if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return false;
        // The round trip comes from the monotonic clock and the midpoint is
        // counted back from the arrival: a jump during the request that an
        // earlier look already caught (detectStep() above then saw nothing)
        // neither stretches the round trip nor mixes the old clock into the
        // offset, which is measured against the clock as it is now.
        const rtt = monotonicRttMs;
        if (!(rtt >= 0) || rtt > this.maxRttMs) return false;

        const sample = serverTimeMs - (receivedAtMs - rtt / 2);
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
        this.detectStep();
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
            steps: this.steps,
        };
    }
}
