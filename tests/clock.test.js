import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/lib/clock.js';

describe('ClockSync', () => {
    it('takes the first sample from the midpoint of the round trip', () => {
        const clock = new ClockSync({ now: () => 10_000 });
        // Sent at 1000, back at 1200: server stamped about local 1100.
        expect(clock.observe(6_100, 1_000, 1_200)).toBe(true);
        expect(clock.offsetMs).toBe(5_000);
        expect(clock.serverNow()).toBe(15_000);
        expect(clock.delayUntil(15_500)).toBe(500);
    });

    it('smooths later samples and ignores implausible ones', () => {
        const clock = new ClockSync({ alpha: 0.5 });
        clock.observe(2_000, 0, 0);
        clock.observe(4_000, 0, 0);
        expect(clock.offsetMs).toBeGreaterThan(2_000);
        expect(clock.offsetMs).toBeLessThan(4_000);

        const before = clock.offsetMs;
        expect(clock.observe(Number.NaN, 0, 10)).toBe(false);
        expect(clock.observe(9_999_999, 0, 60_000)).toBe(false);
        expect(clock.observe(9_999_999, 100, 50)).toBe(false);
        expect(clock.offsetMs).toBe(before);
    });

    it('weights a slow round trip less than a fast one', () => {
        // Both start at offset 0, then see a sample of +1000 ms.
        const fast = new ClockSync({ alpha: 0.5 });
        fast.observe(10_000, 10_000, 10_000);
        fast.observe(11_000, 10_000, 10_000);
        const slow = new ClockSync({ alpha: 0.5 });
        slow.observe(10_000, 10_000, 10_000);
        slow.observe(12_000, 10_000, 12_000);
        expect(fast.offsetMs).toBe(500);
        expect(slow.offsetMs).toBeGreaterThan(0);
        expect(slow.offsetMs).toBeLessThan(fast.offsetMs);
    });

    describe('host clock jumps', () => {
        function steppingClock() {
            const t = { wall: 1_000_000, mono: 5_000 };
            const clock = new ClockSync({ now: () => t.wall, monotonic: () => t.mono });
            const advance = (ms) => { t.wall += ms; t.mono += ms; };
            return { clock, t, advance };
        }

        it('keeps the sync while wall and monotonic time run together', () => {
            const { clock, advance } = steppingClock();
            clock.observe(1_000_100, 1_000_000, 1_000_000);
            for (let i = 0; i < 20; i++) {
                advance(5_000);
                clock.serverNow();
            }
            expect(clock.samples).toBe(1);
            expect(clock.steps).toBe(0);
        });

        it('drops the sync when the host clock steps, and resyncs from the next poll', () => {
            const { clock, t, advance } = steppingClock();
            clock.observe(1_000_100, 1_000_000, 1_000_000);
            expect(clock.serverNow()).toBe(1_000_100);

            advance(1_000);
            t.wall -= 30_000;
            clock.serverNow();
            expect(clock.samples).toBe(0);
            expect(clock.steps).toBe(1);

            advance(5_000);
            const now = t.wall;
            expect(clock.observe(now + 31_100, now, now)).toBe(true);
            expect(clock.serverNow()).toBe(now + 31_100);
        });

        it('ignores a round trip during which the clock stepped', () => {
            const { clock, t } = steppingClock();
            clock.observe(1_000_100, 1_000_000, 1_000_000);
            t.wall += 10_000;
            expect(clock.observe(t.wall + 100, t.wall, t.wall)).toBe(false);
            expect(clock.samples).toBe(0);
        });
    });
});
