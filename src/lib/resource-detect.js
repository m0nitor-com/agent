import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

const CGROUP_V2_ROOT = '/sys/fs/cgroup';
const CGROUP_V1_CPU = '/sys/fs/cgroup/cpu';
const CGROUP_V1_MEMORY = '/sys/fs/cgroup/memory';

function readText(path) {
    try {
        if (!existsSync(path)) return null;
        return readFileSync(path, 'utf8').trim();
    } catch {
        return null;
    }
}

function parsePositiveNumber(value) {
    if (value == null || value === '' || value === 'max') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // cgroup v1 sometimes exposes a near-infinite sentinel (~2^63)
    if (n >= 2 ** 62) return null;
    return n;
}

/**
 * CPU cores available from cgroup cpu.max (v2) or cfs quota/period (v1).
 * Returns null when unlimited or unreadable.
 */
export function readCgroupCpuCores({
    v2CpuMaxPath = `${CGROUP_V2_ROOT}/cpu.max`,
    v1QuotaPath = `${CGROUP_V1_CPU}/cpu.cfs_quota_us`,
    v1PeriodPath = `${CGROUP_V1_CPU}/cpu.cfs_period_us`,
    read = readText,
} = {}) {
    const v2 = read(v2CpuMaxPath);
    if (v2 != null) {
        const [quotaRaw, periodRaw] = v2.split(/\s+/);
        if (quotaRaw === 'max') return null;
        const quota = parsePositiveNumber(quotaRaw);
        const period = parsePositiveNumber(periodRaw) || 100_000;
        if (quota != null && period > 0) return quota / period;
    }

    const quota = parsePositiveNumber(read(v1QuotaPath));
    const period = parsePositiveNumber(read(v1PeriodPath));
    if (quota != null && period != null && period > 0) {
        // quota of -1 means unlimited; parsePositiveNumber already rejects it
        return quota / period;
    }
    return null;
}

/**
 * Memory limit in bytes from cgroup memory.max (v2) or memory.limit_in_bytes (v1).
 * Returns null when unlimited or unreadable.
 */
export function readCgroupMemoryMaxBytes({
    v2MemoryMaxPath = `${CGROUP_V2_ROOT}/memory.max`,
    v1LimitPath = `${CGROUP_V1_MEMORY}/memory.limit_in_bytes`,
    read = readText,
} = {}) {
    const v2 = parsePositiveNumber(read(v2MemoryMaxPath));
    if (v2 != null) return v2;

    return parsePositiveNumber(read(v1LimitPath));
}

function hostCpuCount() {
    return Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
}

/**
 * Detect effective CPU and memory for budget sizing.
 * Prefers cgroup limits (container/K8s) and falls back to host totals.
 */
export function detectResources(options = {}) {
    const cgroupCpus = readCgroupCpuCores(options);
    const cgroupMemoryBytes = readCgroupMemoryMaxBytes(options);
    const hostCpus = hostCpuCount();
    const hostMemoryBytes = os.totalmem();

    const cpus = cgroupCpus != null ? cgroupCpus : hostCpus;
    const memoryBytes = cgroupMemoryBytes != null ? cgroupMemoryBytes : hostMemoryBytes;

    return {
        cpus,
        memoryBytes,
        memoryGiB: memoryBytes / (1024 ** 3),
        source: {
            cpu: cgroupCpus != null ? 'cgroup' : 'host',
            memory: cgroupMemoryBytes != null ? 'cgroup' : 'host',
        },
        host: {
            cpus: hostCpus,
            memoryBytes: hostMemoryBytes,
        },
        cgroup: {
            cpus: cgroupCpus,
            memoryBytes: cgroupMemoryBytes,
        },
    };
}
