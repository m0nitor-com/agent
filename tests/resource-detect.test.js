import { describe, expect, it } from 'vitest';
import {
    readCgroupCpuCores,
    readCgroupMemoryMaxBytes,
    detectResources,
} from '../src/lib/resource-detect.js';

describe('resource-detect', () => {
    it('parses cgroup v2 cpu.max quota', () => {
        const files = {
            '/sys/fs/cgroup/cpu.max': '150000 100000',
        };
        const cpus = readCgroupCpuCores({
            read: (path) => files[path] ?? null,
        });
        expect(cpus).toBe(1.5);
    });

    it('treats cgroup v2 cpu.max max as unlimited', () => {
        const cpus = readCgroupCpuCores({
            read: (path) => (path.endsWith('cpu.max') ? 'max 100000' : null),
        });
        expect(cpus).toBeNull();
    });

    it('parses cgroup v1 cpu quota and period', () => {
        const files = {
            '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000',
            '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
        };
        const cpus = readCgroupCpuCores({
            read: (path) => files[path] ?? null,
        });
        expect(cpus).toBe(2);
    });

    it('parses cgroup v2 memory.max and ignores unlimited sentinels', () => {
        expect(readCgroupMemoryMaxBytes({
            read: (path) => (path.endsWith('memory.max') ? '1073741824' : null),
        })).toBe(1073741824);

        expect(readCgroupMemoryMaxBytes({
            read: (path) => (path.endsWith('memory.max') ? 'max' : null),
        })).toBeNull();

        expect(readCgroupMemoryMaxBytes({
            read: (path) => (path.includes('limit_in_bytes') ? String(2 ** 63 - 1) : null),
        })).toBeNull();
    });

    it('falls back to host totals when cgroup files are absent', () => {
        const resources = detectResources({
            read: () => null,
        });
        expect(resources.source.cpu).toBe('host');
        expect(resources.source.memory).toBe('host');
        expect(resources.cpus).toBeGreaterThan(0);
        expect(resources.memoryBytes).toBeGreaterThan(0);
    });
});
