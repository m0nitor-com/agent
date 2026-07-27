import { describe, expect, it } from 'vitest';
import {
    SKU_PROFILES,
    classifySku,
    computeBudgets,
    computeFormulaBudgets,
    normalizeBudgets,
} from '../src/lib/budgets.js';

describe('budgets', () => {
    it('classifies common SKU shapes', () => {
        expect(classifySku(1, 1)).toBe('sku-1c1g');
        expect(classifySku(2, 2)).toBe('sku-2c2g');
        expect(classifySku(2, 4)).toBe('sku-2c4g');
        expect(classifySku(8, 16)).toBeNull();
    });

    it('lands on the published SKU table for matching resources', () => {
        const one = computeBudgets({
            cpus: 1,
            memoryBytes: 1024 ** 3,
            memoryGiB: 1,
            source: { cpu: 'cgroup', memory: 'cgroup' },
        });
        expect(one.sku).toBe('sku-1c1g');
        expect(one).toMatchObject(SKU_PROFILES['sku-1c1g']);

        const two = computeBudgets({
            cpus: 2,
            memoryBytes: 2 * 1024 ** 3,
            memoryGiB: 2,
            source: { cpu: 'cgroup', memory: 'cgroup' },
        });
        expect(two.sku).toBe('sku-2c2g');
        expect(two.total).toBe(28);
        expect(two.httpMaxSockets).toBe(12);

        const four = computeBudgets({
            cpus: 2,
            memoryBytes: 4 * 1024 ** 3,
            memoryGiB: 4,
            source: { cpu: 'cgroup', memory: 'cgroup' },
        });
        expect(four.sku).toBe('sku-2c4g');
        expect(four.total).toBe(40);
        expect(four.diagnostic).toBe(2);
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
