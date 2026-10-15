import http from 'node:http';
import https from 'node:https';
import {
    DEFAULT_HTTP_MAX_FREE_SOCKETS,
    DEFAULT_HTTP_MAX_SOCKETS,
} from './constants.js';

let poolOptions = {
    maxSockets: DEFAULT_HTTP_MAX_SOCKETS,
    maxFreeSockets: DEFAULT_HTTP_MAX_FREE_SOCKETS,
};
const agents = new Map();

/**
 * Configure shared check-agent socket budgets. Existing agents are destroyed
 * so the next lookup rebuilds them with the new limits.
 */
export function configureHttpCheckAgents(options = {}) {
    const maxSockets = Math.max(1, Number(options.maxSockets) || DEFAULT_HTTP_MAX_SOCKETS);
    const requestedFree = Number(options.maxFreeSockets);
    // 0 is a real setting: keep no idle socket. `||` would turn it into the default.
    const maxFreeSockets = Math.max(
        0,
        Math.min(
            maxSockets,
            Number.isFinite(requestedFree) ? requestedFree : DEFAULT_HTTP_MAX_FREE_SOCKETS,
        ),
    );
    poolOptions = { maxSockets, maxFreeSockets };
    closeHttpCheckAgents();
}

export function getHttpCheckAgentOptions() {
    return { ...poolOptions };
}

export function sharedHttpCheckAgent(protocol, allowPrivate, verifyTls) {
    const key = `${protocol}:${allowPrivate ? 'private' : 'public'}:${verifyTls ? 'verify' : 'insecure'}`;
    if (agents.has(key)) return agents.get(key);

    const { maxSockets } = poolOptions;
    // keepAlive is off on purpose. Node counts maxFreeSockets per host and
    // treats 0 as 256, so a positive free-socket budget keeps a TLS session
    // for every target. That is the RSS climb, and warm sockets make the
    // measured response time depend on whether the pool still held the host.
    // maxSockets still caps how many checks can be in flight together.
    const common = {
        keepAlive: false,
        maxSockets,
        maxTotalSockets: maxSockets,
        scheduling: 'lifo',
        timeout: 30_000,
    };
    const agent = protocol === 'https'
        ? new https.Agent({
            ...common,
            rejectUnauthorized: verifyTls,
            maxCachedSessions: 16,
        })
        : new http.Agent(common);
    agents.set(key, agent);
    return agent;
}

export function closeHttpCheckAgents() {
    for (const agent of agents.values()) agent.destroy();
    agents.clear();
}
