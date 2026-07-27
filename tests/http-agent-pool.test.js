import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    closeHttpCheckAgents,
    configureHttpCheckAgents,
    getHttpCheckAgentOptions,
    sharedHttpCheckAgent,
} from '../src/lib/http-agent-pool.js';

afterEach(() => {
    closeHttpCheckAgents();
    configureHttpCheckAgents({ maxSockets: 6, maxFreeSockets: 2 });
});

describe('HTTP check connection pools', () => {
    it('reuses bounded pools without crossing trust or TLS policy boundaries', () => {
        configureHttpCheckAgents({ maxSockets: 6, maxFreeSockets: 2 });
        const publicAgent = sharedHttpCheckAgent('http', false, true);
        const reusedAgent = sharedHttpCheckAgent('http', false, true);
        const privateAgent = sharedHttpCheckAgent('http', true, true);
        const insecureTlsAgent = sharedHttpCheckAgent('https', false, false);

        expect(reusedAgent).toBe(publicAgent);
        expect(privateAgent).not.toBe(publicAgent);
        expect(insecureTlsAgent).not.toBe(publicAgent);
        expect(publicAgent.maxSockets).toBe(6);
        expect(publicAgent.maxFreeSockets).toBe(2);
        expect(publicAgent.maxTotalSockets).toBe(6);
        expect(getHttpCheckAgentOptions()).toEqual({ maxSockets: 6, maxFreeSockets: 2 });
    });

    it('applies configured socket budgets for larger SKUs', () => {
        configureHttpCheckAgents({ maxSockets: 12, maxFreeSockets: 3 });
        const agent = sharedHttpCheckAgent('https', false, true);
        expect(agent.maxSockets).toBe(12);
        expect(agent.maxFreeSockets).toBe(3);
        expect(agent.maxTotalSockets).toBe(12);
    });

    it('destroys every pool exactly once and recreates it after shutdown', () => {
        const agent = sharedHttpCheckAgent('http', false, true);
        const destroy = vi.spyOn(agent, 'destroy');

        closeHttpCheckAgents();
        closeHttpCheckAgents();

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(sharedHttpCheckAgent('http', false, true)).not.toBe(agent);
    });
});
