import { describe, expect, it, vi } from 'vitest';
import { ResourceGovernor } from '../src/lib/resource-governor.js';

describe('ResourceGovernor', () => {
    it('reduces effective concurrency under soft RSS pressure', () => {
        const rss = 400 * 1024 * 1024;
        const onLimitsChange = vi.fn();
        const governor = new ResourceGovernor({
            baseLimits: { total: 16, network: 13, database: 2, diagnostic: 1 },
            softRssBytes: 350 * 1024 * 1024,
            hardRssBytes: 550 * 1024 * 1024,
            getEventLoopP99Ms: () => 1,
            getRssBytes: () => rss,
            onLimitsChange,
            restoreStableTicks: 2,
        });

        governor.tick();
        expect(governor.effective.total).toBe(12);
        expect(onLimitsChange).toHaveBeenCalled();
        expect(governor.reductionSteps).toBe(1);
    });

    it('pauses and marks saturated on hard RSS pressure', () => {
        const onHardPressure = vi.fn();
        const governor = new ResourceGovernor({
            baseLimits: { total: 16, network: 13, database: 2, diagnostic: 1 },
            softRssBytes: 350 * 1024 * 1024,
            hardRssBytes: 550 * 1024 * 1024,
            getEventLoopP99Ms: () => 1,
            getRssBytes: () => 600 * 1024 * 1024,
            onHardPressure,
        });

        const telemetry = governor.tick();
        expect(telemetry.paused).toBe(true);
        expect(telemetry.saturated).toBe(true);
        expect(onHardPressure).toHaveBeenCalled();
    });

    it('restores stepwise after stable ticks', () => {
        let rss = 400 * 1024 * 1024;
        const governor = new ResourceGovernor({
            baseLimits: { total: 16, network: 13, database: 2, diagnostic: 1 },
            softRssBytes: 350 * 1024 * 1024,
            hardRssBytes: 550 * 1024 * 1024,
            getEventLoopP99Ms: () => 1,
            getRssBytes: () => rss,
            restoreStableTicks: 2,
        });

        governor.tick();
        const reduced = governor.effective.total;
        expect(reduced).toBeLessThan(16);

        rss = 100 * 1024 * 1024;
        governor.tick();
        governor.tick();
        expect(governor.effective.total).toBeGreaterThanOrEqual(reduced);
        governor.tick();
        governor.tick();
        expect(governor.reductionSteps).toBe(0);
        expect(governor.effective.total).toBe(16);
        expect(governor.paused).toBe(false);
    });

    it('does not cut slots because the event loop was slow', () => {
        const governor = new ResourceGovernor({
            baseLimits: { total: 48, network: 46, database: 2, diagnostic: 1 },
            softRssBytes: 350 * 1024 * 1024,
            hardRssBytes: 550 * 1024 * 1024,
            getEventLoopP99Ms: () => 800,
            getRssBytes: () => 100 * 1024 * 1024,
            restoreStableTicks: 100,
        });

        for (let i = 0; i < 40; i++) governor.tick();
        expect(governor.effective.total).toBe(48);
        expect(governor.reductionSteps).toBe(0);
    });

    it('restores the full ceiling as soon as checks are waiting', () => {
        const governor = new ResourceGovernor({
            baseLimits: { total: 48, network: 46, database: 2, diagnostic: 1 },
            softRssBytes: 350 * 1024 * 1024,
            hardRssBytes: 550 * 1024 * 1024,
            getEventLoopP99Ms: () => 1,
            getRssBytes: () => 400 * 1024 * 1024,
            restoreStableTicks: 100,
        });

        governor.tick();
        governor.tick();
        governor.tick();
        expect(governor.effective.total).toBeLessThan(48);

        governor.tick({ queued: 100 });
        expect(governor.effective.total).toBe(48);
        expect(governor.reductionSteps).toBe(0);
        expect(governor.paused).toBe(false);
    });
});
