/**
 * Compute the next poll delay with exponential backoff + full jitter.
 *
 * Steady-state (no failures): returns baseInterval exactly - no jitter on the
 * happy path, since steady-state cadence should stay deterministic.
 *
 * Under failure: target = min(baseInterval * 2^failures, maxInterval), then
 * full-jittered to a random value in [0, target). Full jitter (vs proportional)
 * is critical to prevent thundering-herd recovery when many probes failed at
 * roughly the same time and the console comes back up.
 *
 * @param {number} baseInterval - steady-state interval (ms)
 * @param {number} maxInterval - cap (ms); should be >= baseInterval
 * @param {number} consecutiveFailures - failure count since last success
 * @param {() => number} [rng] - injectable RNG for tests; defaults to Math.random
 * @returns {number} delay in ms
 */
export function computeNextPollDelay(baseInterval, maxInterval, consecutiveFailures, rng = Math.random) {
    if (consecutiveFailures <= 0) return baseInterval;
    const target = Math.min(baseInterval * Math.pow(2, consecutiveFailures), maxInterval);
    return Math.floor(rng() * target);
}
