import { describe, it, expect } from 'vitest';
import { validateMonitor } from '../src/lib/validator.js';

describe('validateMonitor', () => {
    const validMonitor = {
        id: 1,
        type: 'http',
        name: 'Test Monitor',
        url: 'https://example.com',
        timeout: 30,
        success_criteria: {
            status_codes: [200],
            max_response_time: 5000,
        },
    };

    it('returns validated monitor for valid input', () => {
        const result = validateMonitor(validMonitor);
        expect(result).not.toBeNull();
        expect(result.id).toBe(1);
        expect(result.type).toBe('http');
        expect(result.url).toBe('https://example.com');
    });

    it('returns null for null/undefined input', () => {
        expect(validateMonitor(null)).toBeNull();
        expect(validateMonitor(undefined)).toBeNull();
        expect(validateMonitor('string')).toBeNull();
    });

    it('returns null when id is missing', () => {
        expect(validateMonitor({ type: 'http', url: 'https://example.com' })).toBeNull();
    });

    it('returns null when url is missing or empty', () => {
        expect(validateMonitor({ id: 1, type: 'http' })).toBeNull();
        expect(validateMonitor({ id: 1, type: 'http', url: '' })).toBeNull();
        expect(validateMonitor({ id: 1, type: 'http', url: '   ' })).toBeNull();
    });

    it('clamps timeout to max 300s', () => {
        const result = validateMonitor({ ...validMonitor, timeout: 999999 });
        expect(result.timeout).toBe(300);
    });

    it('sets default timeout when invalid', () => {
        const result = validateMonitor({ ...validMonitor, timeout: -5 });
        expect(result.timeout).toBe(30);

        const result2 = validateMonitor({ ...validMonitor, timeout: 'abc' });
        expect(result2.timeout).toBe(30);
    });

    it('preserves valid timeout', () => {
        const result = validateMonitor({ ...validMonitor, timeout: 60 });
        expect(result.timeout).toBe(60);
    });

    it('normalizes success_criteria to empty object when invalid', () => {
        const result = validateMonitor({ ...validMonitor, success_criteria: 'invalid' });
        expect(result.success_criteria).toEqual({
            ssl_min_days: 7,
        });
    });

    it('filters invalid status codes', () => {
        const result = validateMonitor({
            ...validMonitor,
            success_criteria: { status_codes: [200, 'abc', 999, 201] },
        });
        expect(result.success_criteria.status_codes).toEqual([200, 201]);
    });

    it('normalizes type to lowercase', () => {
        const result = validateMonitor({ ...validMonitor, type: 'HTTP' });
        expect(result.type).toBe('http');
    });

    it('normalizes keywords to empty array when not an array', () => {
        const result = validateMonitor({
            ...validMonitor,
            success_criteria: { keywords: 'not-an-array' },
        });
        expect(result.success_criteria.keywords).toEqual([]);
    });

    it('sets default ssl_min_days', () => {
        const result = validateMonitor({
            ...validMonitor,
            success_criteria: {},
        });
        expect(result.success_criteria.ssl_min_days).toBe(7);
    });

    it('rejects file: scheme for http monitors', () => {
        const result = validateMonitor({
            ...validMonitor,
            type: 'http',
            url: 'file:///etc/passwd',
        });
        expect(result).toBeNull();
    });

    it('accepts bare hostname for tcp monitors (no scheme required)', () => {
        const result = validateMonitor({
            id: 2,
            type: 'tcp',
            name: 'TCP Monitor',
            url: 'myserver.internal',
            timeout: 10,
            success_criteria: {},
        });
        expect(result).not.toBeNull();
        expect(result.url).toBe('myserver.internal');
    });

    it('passes through allow_private_target field on http monitors', () => {
        const result = validateMonitor({
            ...validMonitor,
            allow_private_target: true,
        });
        expect(result).not.toBeNull();
        expect(result.allow_private_target).toBe(true);
    });
});
