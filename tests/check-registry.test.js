import { describe, expect, it } from 'vitest';
import { CheckRegistry } from '../src/lib/check-registry.js';

describe('CheckRegistry', () => {
    it('registers handlers, aliases, capabilities, and budgets', () => {
        const handler = async () => ({ is_success: true });
        const registry = new CheckRegistry()
            .register('tcp', { handler, budget: 'network' })
            .alias('ssh', 'tcp');

        expect(registry.get('TCP').handler).toBe(handler);
        expect(registry.budgetFor('ssh')).toBe('network');
        expect(registry.capabilities()).toEqual(['ssh', 'tcp']);
    });

    it('rejects duplicate and malformed registrations', () => {
        const registry = new CheckRegistry()
            .register('http', { handler: async () => {}, budget: 'network' });

        expect(() => registry.register('http', { handler: async () => {}, budget: 'network' }))
            .toThrow(/already registered/);
        expect(() => registry.register('bad', { handler: async () => {}, budget: 'other' }))
            .toThrow(/invalid budget/);
    });
});
