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
    const maxFreeSockets = Math.max(
        1,
        Math.min(maxSockets, Number(options.maxFreeSockets) || DEFAULT_HTTP_MAX_FREE_SOCKETS),
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

    const { maxSockets, maxFreeSockets } = poolOptions;
    const common = {
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets,
        maxFreeSockets,
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
