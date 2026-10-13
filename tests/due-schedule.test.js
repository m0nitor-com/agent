import { afterEach, describe, expect, it, vi } from 'vitest';
import { DueSchedule, LatencyWindow } from '../src/lib/due-schedule.js';

function fakeClock(start = 0) {
    let now = start;
    return {
        serverNow: () => now,
        delayUntil: (at) => at - now,
        set: (value) => { now = value; },
    };
}

describe('DueSchedule', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns entries in due order regardless of insertion order', () => {
        const clock = fakeClock(0);
        const schedule = new DueSchedule({ clock, onDue: () => {} });
        for (const at of [500, 100, 900, 300, 700, 200]) schedule.add(at, { at });
        clock.set(1_000);
        expect(schedule.takeDue().map((entry) => entry.dueAt)).toEqual([100, 200, 300, 500, 700, 900]);
        schedule.stop();
    });

    it('only hands out what is due and keeps the rest', () => {
        const clock = fakeClock(250);
        const schedule = new DueSchedule({ clock, onDue: () => {} });
        schedule.add(100, 'a');
        schedule.add(400, 'b');
        expect(schedule.takeDue().map((entry) => entry.item)).toEqual(['a']);
        expect(schedule.size).toBe(1);
        schedule.stop();
    });

    it('fires one timer at the earliest due time', async () => {
        vi.useFakeTimers();
        const clock = fakeClock(0);
        const fired = [];
        const schedule = new DueSchedule({
            clock,
            onDue: (entries) => fired.push(...entries.map((entry) => entry.item)),
        });
        schedule.add(300, 'late');
        schedule.add(100, 'early');

        clock.set(99);
        await vi.advanceTimersByTimeAsync(99);
        expect(fired).toEqual([]);

        clock.set(100);
        await vi.advanceTimersByTimeAsync(1);
        expect(fired).toEqual(['early']);

        clock.set(300);
        await vi.advanceTimersByTimeAsync(200);
        expect(fired).toEqual(['early', 'late']);
        expect(vi.getTimerCount()).toBe(0);
        schedule.stop();
    });

    it('stop drops pending entries and disarms the timer', () => {
        vi.useFakeTimers();
        const schedule = new DueSchedule({ clock: fakeClock(0), onDue: () => {} });
        schedule.add(1_000, 'x');
        expect(vi.getTimerCount()).toBe(1);
        expect(schedule.stop().map((entry) => entry.item)).toEqual(['x']);
        expect(vi.getTimerCount()).toBe(0);
        schedule.add(10, 'ignored');
        expect(schedule.size).toBe(0);
    });
});

describe('LatencyWindow', () => {
    it('reports nearest-rank percentiles', () => {
        const window = new LatencyWindow(1000);
        for (let value = 1; value <= 100; value++) window.push(value);
        expect(window.percentiles()).toEqual({ p50: 50, p95: 95, p99: 99, samples: 100 });
    });

    it('keeps only the most recent samples', () => {
        const window = new LatencyWindow(3);
        [1000, 1000, 1, 2, 3].forEach((value) => window.push(value));
        expect(window.percentiles().p99).toBe(3);
        expect(window.percentiles().samples).toBe(3);
    });
});
