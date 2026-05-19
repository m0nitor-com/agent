import { describe, it, expect } from 'vitest';
import { computeNextPollDelay } from '../src/lib/backoff.js';

describe('computeNextPollDelay', () => {
    it('returns exactly baseInterval when consecutiveFailures === 0 (no jitter on success path)', () => {
        const result = computeNextPollDelay(5000, 300_000, 0, () => 0.5);
        expect(result).toBe(5000);
    });

    it('returns 0 with rng=()=>0 and 9999 with rng=()=>0.999 when failures=1, base=5000, max=300000', () => {
        expect(computeNextPollDelay(5000, 300_000, 1, () => 0)).toBe(0);
        expect(computeNextPollDelay(5000, 300_000, 1, () => 0.999)).toBe(9999);
    });

    it('target grows ~2x per failure before the cap is reached (n=1..4)', () => {
        const rng = () => 0.9999;
        const base = 5000;
        const max = 300_000;

        const r1 = computeNextPollDelay(base, max, 1, rng);
        const r2 = computeNextPollDelay(base, max, 2, rng);
        const r3 = computeNextPollDelay(base, max, 3, rng);
        const r4 = computeNextPollDelay(base, max, 4, rng);

        // target_n = min(base * 2^n, max); result = floor(rng() * target_n)
        expect(r1).toBe(Math.floor(0.9999 * 10_000));
        expect(r2).toBe(Math.floor(0.9999 * 20_000));
        expect(r3).toBe(Math.floor(0.9999 * 40_000));
        expect(r4).toBe(Math.floor(0.9999 * 80_000));

        // Confirm monotone ~2x growth before cap
        expect(r2).toBeGreaterThan(r1);
        expect(r3).toBeGreaterThan(r2);
        expect(r4).toBeGreaterThan(r3);
    });

    it('respects the cap when consecutiveFailures = 50 (result <= maxInterval)', () => {
        const result = computeNextPollDelay(5000, 300_000, 50, () => 0.9999);
        expect(result).toBeLessThanOrEqual(300_000);
    });

    it('is deterministic with injected rng=()=>0.5 for n=1..6', () => {
        const rng = () => 0.5;
        const base = 5000;
        const max = 300_000;

        expect(computeNextPollDelay(base, max, 1, rng)).toBe(5000);
        expect(computeNextPollDelay(base, max, 2, rng)).toBe(10000);
        expect(computeNextPollDelay(base, max, 3, rng)).toBe(20000);
        expect(computeNextPollDelay(base, max, 4, rng)).toBe(40000);
        expect(computeNextPollDelay(base, max, 5, rng)).toBe(80000);
        expect(computeNextPollDelay(base, max, 6, rng)).toBe(150000);
    });

    it('handles Math.pow(2, n) overflow gracefully (consecutiveFailures=2000)', () => {
        const result = computeNextPollDelay(5000, 300_000, 2000, () => 0.5);
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeLessThanOrEqual(300_000);
    });

    it('edge case: maxInterval === baseInterval — returns floor(rng() * base)', () => {
        const result = computeNextPollDelay(5000, 5000, 10, () => 0.5);
        expect(result).toBe(2500);
    });
});
