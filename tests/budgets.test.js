import { describe, expect, it } from 'vitest';
import {
    SKU_PROFILES,
    classifySku,
    computeBudgets,
    computeFormulaBudgets,
    computeFullBudgets,
    normalizeBudgets,
} from '../src/lib/budgets.js';

describe('budgets', () => {
    it('classifies common SKU shapes', () => {
        expect(classifySku(1, 1)).toBe('sku-1c1g');
        expect(classifySku(2, 2)).toBe('sku-2c2g');
        expect(classifySku(2, 4)).toBe('sku-2c4g');
        expect(classifySku(8, 16)).toBeNull();
    });

    it('fills the detected machine unless a SKU is forced', () => {
        const one = computeBudgets({
            cpus: 1,
            memoryBytes: 1024 ** 3,
            memoryGiB: 1,
            source: { cpu: 'cgroup', memory: 'cgroup' },
        });
        expect(one.sku).toBe('full');
        expect(one.total).toBe(48);
        expect(one.network).toBe(46);
        expect(one.httpMaxSockets).toBe(46);

        const pinned = computeBudgets({
            cpus: 1,
            memoryBytes: 1024 ** 3,
            memoryGiB: 1,
            source: { cpu: 'cgroup', memory: 'cgroup' },
        }, { sku: 'sku-1c1g' });
        expect(pinned.sku).toBe('sku-1c1g');
        expect(pinned).toMatchObject(SKU_PROFILES['sku-1c1g']);
    });

    it('scales the full profile with the console coefficients', () => {
        const doubled = computeFullBudgets(2, 4, 4 * 1024 ** 3, {
            total_per_cpu: 48,
            socket_ratio: 1,
        });
        expect(doubled.total).toBe(96);
        expect(doubled.httpMaxSockets).toBe(doubled.network);
    });

    it('uses the documented formula outside named SKUs', () => {
        const formula = computeFormulaBudgets(4, 8, 8 * 1024 ** 3);
        expect(formula.total).toBe(64);
        expect(formula.database).toBe(4);
        expect(formula.diagnostic).toBe(2);
        expect(formula.network).toBe(58);
        expect(formula.httpMaxSockets).toBe(24);
    });

    it('normalizes ENV overrides against total', () => {
        const normalized = normalizeBudgets({
            total: 16,
            network: 40,
            database: 2,
            diagnostic: 1,
            httpMaxSockets: 100,
            httpMaxFreeSockets: 10,
            queueEntries: 500,
            queueBytes: 4 * 1024 * 1024,
            batchSize: 50,
            batchBytes: 512 * 1024,
            softRssBytes: 350 * 1024 * 1024,
            hardRssBytes: 550 * 1024 * 1024,
        });
        expect(normalized.network).toBeLessThanOrEqual(normalized.total);
        expect(normalized.httpMaxSockets).toBeLessThanOrEqual(24);
        expect(normalized.httpMaxSockets).toBeLessThanOrEqual(Math.max(4, normalized.network));
    });
});
