import { describe, expect, it, vi } from 'vitest';
import { FairScheduler } from '../src/lib/fair-scheduler.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FairScheduler', () => {
    it('honors total and per-budget concurrency while preserving result order', async () => {
        const scheduler = new FairScheduler({
            total: 3,
            network: 2,
            database: 1,
            diagnostic: 1,
        });
        const active = { total: 0, network: 0, database: 0, diagnostic: 0 };
        const peaks = { ...active };
        const items = [
            { id: 1, budget: 'network' },
            { id: 2, budget: 'network' },
            { id: 3, budget: 'network' },
            { id: 4, budget: 'database' },
            { id: 5, budget: 'database' },
            { id: 6, budget: 'diagnostic' },
        ];

        const results = await scheduler.run(
            items,
            (item) => item.budget,
            async (item) => {
                active.total++;
                active[item.budget]++;
                for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], active[key]);
                await wait(5);
                active.total--;
                active[item.budget]--;
                return item.id;
            },
        );

        expect(results).toEqual([1, 2, 3, 4, 5, 6]);
        expect(peaks.total).toBeLessThanOrEqual(3);
        expect(peaks.network).toBeLessThanOrEqual(2);
        expect(peaks.database).toBeLessThanOrEqual(1);
        expect(peaks.diagnostic).toBeLessThanOrEqual(1);
    });

    it('streams results through onResult without retaining O(poll_size) memory', async () => {
        const scheduler = new FairScheduler({
            total: 2,
            network: 2,
            database: 1,
            diagnostic: 1,
        });
        const items = Array.from({ length: 20 }, (_, id) => ({ id, budget: 'network' }));
        const seen = [];
        let peakRetained = 0;

        const results = await scheduler.run(
            items,
            (item) => item.budget,
            async (item) => {
                await wait(1);
                return { monitor_id: item.id, is_success: true };
            },
            {
                onResult: (result) => {
                    seen.push(result.monitor_id);
                },
                // retainResults defaults false when onResult is set
            },
        );

        // Observe retainedResults via onStateChange on a second run.
        const observer = new FairScheduler({
            total: 2,
            network: 2,
            database: 1,
            diagnostic: 1,
            onStateChange: ({ retainedResults }) => {
                peakRetained = Math.max(peakRetained, retainedResults || 0);
            },
        });
        await observer.run(
            items,
            (item) => item.budget,
            async (item) => {
                await wait(1);
                return { monitor_id: item.id };
            },
            {
                onResult: () => {},
            },
        );

        expect(results).toEqual([]);
        expect(seen).toHaveLength(20);
        expect(peakRetained).toBe(0);
    });

    it('pauses new work and resumes when unpaused', async () => {
        const scheduler = new FairScheduler({
            total: 1,
            network: 1,
            database: 1,
            diagnostic: 1,
        });
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        const started = [];

        const runPromise = scheduler.run(
            [
                { id: 1, budget: 'network' },
                { id: 2, budget: 'network' },
            ],
            (item) => item.budget,
            async (item) => {
                started.push(item.id);
                if (item.id === 1) await firstGate;
                return item.id;
            },
        );

        await vi.waitFor(() => expect(started).toEqual([1]));
        scheduler.setPaused(true);
        releaseFirst();
        await wait(20);
        expect(started).toEqual([1]);

        scheduler.setPaused(false);
        await runPromise;
        expect(started).toEqual([1, 2]);
    });
});
