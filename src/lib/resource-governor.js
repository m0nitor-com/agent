import {
    GOVERNOR_EVENT_LOOP_P99_HARD_MS,
    GOVERNOR_EVENT_LOOP_P99_SOFT_MS,
    GOVERNOR_RESTORE_STABLE_TICKS,
} from './constants.js';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Resource governor: event-loop p99 and RSS soft pressure reduce effective
 * concurrency stepwise; RSS hard pauses the scheduler and signals saturation.
 */
export class ResourceGovernor {
    constructor({
        baseLimits,
        softRssBytes,
        hardRssBytes,
        getEventLoopP99Ms,
        getRssBytes,
        onLimitsChange = null,
        onHardPressure = null,
        onRestore = null,
        logger = null,
        softEventLoopMs = GOVERNOR_EVENT_LOOP_P99_SOFT_MS,
        hardEventLoopMs = GOVERNOR_EVENT_LOOP_P99_HARD_MS,
        restoreStableTicks = GOVERNOR_RESTORE_STABLE_TICKS,
    }) {
        this.baseLimits = {
            total: Math.max(1, baseLimits.total),
            network: Math.max(1, baseLimits.network),
            database: Math.max(1, baseLimits.database),
            diagnostic: Math.max(1, baseLimits.diagnostic),
        };
        this.effective = { ...this.baseLimits };
        this.softRssBytes = softRssBytes;
        this.hardRssBytes = hardRssBytes;
        this.getEventLoopP99Ms = getEventLoopP99Ms;
        this.getRssBytes = getRssBytes;
        this.onLimitsChange = onLimitsChange;
        this.onHardPressure = onHardPressure;
        this.onRestore = onRestore;
        this.logger = logger;
        this.softEventLoopMs = softEventLoopMs;
        this.hardEventLoopMs = hardEventLoopMs;
        this.restoreStableTicks = restoreStableTicks;
        this.reductionSteps = 0;
        this.stableTicks = 0;
        this.pressureTicks = 0;
        this.paused = false;
        this.saturated = false;
        this.lastAction = null;
    }

    currentLimits() {
        return { ...this.effective };
    }

    telemetry() {
        return {
            paused: this.paused,
            saturated: this.saturated,
            reduction_steps: this.reductionSteps,
            stable_ticks: this.stableTicks,
            soft_rss_bytes: this.softRssBytes,
            hard_rss_bytes: this.hardRssBytes,
            effective: this.currentLimits(),
            base: { ...this.baseLimits },
            last_action: this.lastAction,
        };
    }

    applyLimits(reason) {
        this.onLimitsChange?.(this.currentLimits(), reason);
    }

    reduce(reason) {
        const nextTotal = Math.max(1, Math.floor(this.effective.total * 0.75));
        if (nextTotal >= this.effective.total && this.effective.total <= 1) {
            this.lastAction = reason;
            return false;
        }
        const scale = nextTotal / this.baseLimits.total;
        this.effective = {
            total: nextTotal,
            network: Math.max(1, Math.min(
                this.baseLimits.network,
                Math.floor(this.baseLimits.network * scale),
                nextTotal,
            )),
            database: Math.max(1, Math.min(this.baseLimits.database, nextTotal)),
            diagnostic: Math.max(1, Math.min(this.baseLimits.diagnostic, nextTotal)),
        };
        this.effective.network = Math.max(
            1,
            Math.min(this.effective.network, Math.max(1, nextTotal - this.effective.database)),
        );
        this.reductionSteps++;
        this.stableTicks = 0;
        this.lastAction = reason;
        this.logger?.warn({
            reason,
            effective: this.effective,
            steps: this.reductionSteps,
        }, '[GOVERNOR] Reduced effective concurrency');
        this.applyLimits(reason);
        return true;
    }

    restoreStep(reason = 'restore') {
        if (this.reductionSteps <= 0 && !this.paused) return false;
        this.reductionSteps = Math.max(0, this.reductionSteps - 1);
        if (this.reductionSteps === 0) {
            this.effective = { ...this.baseLimits };
            this.paused = false;
            this.saturated = false;
            this.onRestore?.(reason);
        } else {
            const scale = Math.pow(0.75, this.reductionSteps);
            const nextTotal = Math.max(1, Math.floor(this.baseLimits.total * scale));
            this.effective = {
                total: nextTotal,
                network: Math.max(1, Math.floor(this.baseLimits.network * scale)),
                database: Math.max(1, Math.min(this.baseLimits.database, nextTotal)),
                diagnostic: Math.max(1, Math.min(this.baseLimits.diagnostic, nextTotal)),
            };
            this.effective.network = clamp(this.effective.network, 1, this.effective.total);
            this.paused = false;
        }
        this.lastAction = reason;
        this.logger?.info({
            reason,
            effective: this.effective,
            steps: this.reductionSteps,
        }, '[GOVERNOR] Restored concurrency step');
        this.applyLimits(reason);
        return true;
    }

    enterHardPressure(reason, rss) {
        this.paused = true;
        this.saturated = true;
        this.stableTicks = 0;
        this.lastAction = reason;
        this.logger?.error({
            reason,
            rss_bytes: rss,
            hard_rss_bytes: this.hardRssBytes,
        }, '[GOVERNOR] Hard RSS pressure - pausing scheduler');
        this.onHardPressure?.({ reason, rss });
        this.applyLimits(reason);
    }

    tick() {
        const p99 = Number(this.getEventLoopP99Ms?.() || 0);
        const rss = Number(this.getRssBytes?.() || 0);

        if (rss >= this.hardRssBytes) {
            this.pressureTicks = 0;
            this.enterHardPressure('rss_hard', rss);
            return this.telemetry();
        }

        const softPressure = rss >= this.softRssBytes || p99 >= this.softEventLoopMs;
        const hardLag = p99 >= this.hardEventLoopMs;

        if (softPressure || hardLag) {
            this.pressureTicks++;
            this.stableTicks = 0;
            // Reduce on first pressure tick, then every 3rd tick; hard lag always reduces.
            if (hardLag || this.pressureTicks === 1 || this.pressureTicks % 3 === 0) {
                this.reduce(hardLag ? 'event_loop_hard' : (rss >= this.softRssBytes ? 'rss_soft' : 'event_loop_soft'));
            }
            return this.telemetry();
        }

        this.pressureTicks = 0;
        this.stableTicks++;
        if (this.paused || this.reductionSteps > 0) {
            if (this.stableTicks >= this.restoreStableTicks) {
                this.stableTicks = 0;
                this.restoreStep('stable');
            }
        } else {
            this.saturated = false;
        }

        return this.telemetry();
    }
}
