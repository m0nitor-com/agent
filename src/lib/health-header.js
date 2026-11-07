import { HEALTH_HEADER_MAX_CHARS } from './constants.js';

const encode = (health) => Buffer.from(JSON.stringify(health)).toString('base64url');

// Optional parts, least important first. Each step edits a deep copy.
const DROP_STEPS = [
    (h) => { delete h.report_coalescer; },
    (h) => { delete h.budgets; },
    (h) => {
        if (!h.governor) return;
        h.governor = {
            paused: h.governor.paused,
            saturated: h.governor.saturated,
            reduction_steps: h.governor.reduction_steps,
            effective: { total: h.governor.effective?.total },
        };
    },
    (h) => { if (h.result_queue) delete h.result_queue.counters; },
    (h) => { delete h.egress; },
    (h) => { if (h.schedule) delete h.schedule.start_delay_ms; },
    (h) => {
        if (!h.push) return;
        delete h.push.last_close;
        delete h.push.wake_delay_ms;
    },
    (h) => {
        if (!h.push) return;
        delete h.push.rtt_ms;
        delete h.push.last_error;
        delete h.push.last_wake_age_s;
        delete h.push.subscribe_ms;
    },
    (h) => { delete h.counters; },
    (h) => { delete h.result_queue; },
    (h) => { delete h.governor; },
    (h) => { if (h.schedule) delete h.schedule.clock; },
    (h) => { delete h.active_handles; },
    (h) => {
        delete h.active_checks;
        delete h.last_successful_poll;
        delete h.last_poll_attempt;
    },
    (h) => {
        if (h.memory) h.memory = { rss_bytes: h.memory.rss_bytes };
        if (h.push) h.push = { state: h.push.state };
    },
];

/**
 * Encodes the health snapshot for the X-Agent-Health header. A value over the
 * limit would be cut into invalid base64 and the console would drop the whole
 * snapshot, so optional parts are removed (least important first) until it
 * fits. Returns null when even the core does not fit.
 */
export function buildHealthHeader(health, maxChars = HEALTH_HEADER_MAX_CHARS) {
    let encoded = encode(health);
    if (encoded.length <= maxChars) return encoded;

    const copy = JSON.parse(JSON.stringify(health));
    for (const step of DROP_STEPS) {
        step(copy);
        encoded = encode(copy);
        if (encoded.length <= maxChars) return encoded;
    }
    return null;
}
