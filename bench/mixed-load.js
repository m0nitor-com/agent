import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { FairScheduler } from '../src/lib/fair-scheduler.js';
import { SKU_PROFILES } from '../src/lib/budgets.js';
import {
    DEFAULT_CONCURRENCY_LIMIT,
    DEFAULT_DATABASE_CONCURRENCY,
    DEFAULT_DIAGNOSTIC_CONCURRENCY,
    DEFAULT_NETWORK_CONCURRENCY,
} from '../src/lib/constants.js';

const CHECKS = Number(process.env.BENCH_CHECKS || 12_000);
const RUNS = Number(process.env.BENCH_RUNS || 3);
const MODE = process.argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1] || 'runtime';
const PROFILE = process.env.BENCH_PROFILE || 'stress';
const TYPES = ['http', 'ping', 'tcp', 'udp', 'dns', 'mysql', 'diagnostic'];
const DURATIONS = [1, 2, 3, 5, 8, 2, 13];
const BUDGETS = {
    http: 'network',
    ping: 'network',
    tcp: 'network',
    udp: 'network',
    dns: 'network',
    mysql: 'database',
    diagnostic: 'diagnostic',
};
const BODY_PREVIEW = 'x'.repeat(512);

const SKU_ALIASES = {
    '1c1g': 'sku-1c1g',
    'sku-1c1g': 'sku-1c1g',
    '2c2g': 'sku-2c2g',
    'sku-2c2g': 'sku-2c2g',
    '2c4g': 'sku-2c4g',
    'sku-2c4g': 'sku-2c4g',
};

function resolveSkuBudgets() {
    const alias = SKU_ALIASES[String(process.env.BENCH_SKU || '').toLowerCase()];
    if (alias && SKU_PROFILES[alias]) {
        return {
            id: alias,
            total: SKU_PROFILES[alias].total,
            network: SKU_PROFILES[alias].network,
            database: SKU_PROFILES[alias].database,
            diagnostic: SKU_PROFILES[alias].diagnostic,
            batchSize: SKU_PROFILES[alias].batchSize,
        };
    }
    return {
        id: 'default',
        total: DEFAULT_CONCURRENCY_LIMIT,
        network: DEFAULT_NETWORK_CONCURRENCY,
        database: DEFAULT_DATABASE_CONCURRENCY,
        diagnostic: DEFAULT_DIAGNOSTIC_CONCURRENCY,
        batchSize: 50,
    };
}

const skuBudgets = resolveSkuBudgets();

function typeIndexFor(index) {
    return PROFILE === 'typical'
        ? (index % 100 === 99 ? 6 : index % 10 === 9 ? 5 : index % 5)
        : index % TYPES.length;
}

function fakeCheck(index) {
    return new Promise((resolve) => {
        const typeIndex = typeIndexFor(index);
        const type = TYPES[typeIndex];
        const duration = DURATIONS[typeIndex];
        setTimeout(() => resolve({
            monitor_id: index + 1,
            type,
            is_success: true,
            response_time_ms: duration,
            response_body_preview: BODY_PREVIEW,
        }), duration);
    });
}

/**
 * Approximate micro-batch reporting cost: one delayed HTTP per batch,
 * not one per result. Still synthetic (no real sockets).
 */
async function report(results, batchSize) {
    let batches = 0;
    for (let offset = 0; offset < results.length; offset += batchSize) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        batches++;
    }
    return batches;
}

async function legacyRun() {
    const concurrency = 30;
    let reportBatches = 0;
    for (let offset = 0; offset < CHECKS; offset += concurrency) {
        const count = Math.min(concurrency, CHECKS - offset);
        const results = await Promise.all(
            Array.from({ length: count }, (_, index) => fakeCheck(offset + index)),
        );
        await new Promise((resolve) => setTimeout(resolve, 1));
        reportBatches++;
        void results;
    }
    return reportBatches;
}

async function runtimeRun() {
    const scheduler = new FairScheduler({
        total: skuBudgets.total,
        network: skuBudgets.network,
        database: skuBudgets.database,
        diagnostic: skuBudgets.diagnostic,
    });
    const items = Array.from({ length: CHECKS }, (_, index) => ({
        index,
        type: TYPES[typeIndexFor(index)],
    }));
    const results = await scheduler.run(
        items,
        (item) => BUDGETS[item.type],
        (item) => fakeCheck(item.index),
    );
    return report(results, skuBudgets.batchSize);
}

async function measuredRun(iteration) {
    global.gc?.();
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    let peakRss = process.memoryUsage().rss;
    let peakHeap = process.memoryUsage().heapUsed;
    let peakHandles = process._getActiveHandles?.().length || 0;
    const sampler = setInterval(() => {
        const memory = process.memoryUsage();
        peakRss = Math.max(peakRss, memory.rss);
        peakHeap = Math.max(peakHeap, memory.heapUsed);
        peakHandles = Math.max(peakHandles, process._getActiveHandles?.().length || 0);
    }, 2);

    const started = performance.now();
    const reportBatchCount = MODE === 'legacy' ? await legacyRun() : await runtimeRun();
    const elapsedMs = performance.now() - started;
    clearInterval(sampler);
    await new Promise((resolve) => setImmediate(resolve));
    loopDelay.disable();

    return {
        iteration,
        mode: MODE === 'legacy' ? 'legacy-fixed-chunks' : 'runtime-fair-budgets',
        checks: CHECKS,
        profile: PROFILE,
        sku: skuBudgets.id,
        concurrency: {
            total: skuBudgets.total,
            network: skuBudgets.network,
            database: skuBudgets.database,
            diagnostic: skuBudgets.diagnostic,
        },
        elapsed_ms: Number(elapsedMs.toFixed(2)),
        throughput_per_second: Number((CHECKS / (elapsedMs / 1000)).toFixed(2)),
        peak_rss_bytes: peakRss,
        peak_heap_bytes: peakHeap,
        event_loop_delay_mean_ms: Number((loopDelay.mean / 1e6).toFixed(3)),
        event_loop_delay_p99_ms: Number((loopDelay.percentile(99) / 1e6).toFixed(3)),
        peak_active_handles: peakHandles,
        report_batch_count: reportBatchCount,
    };
}

if (!['legacy', 'runtime'].includes(MODE)) {
    throw new Error('Use --mode=legacy or --mode=runtime');
}

const runs = [];
for (let iteration = 1; iteration <= RUNS; iteration++) {
    runs.push(await measuredRun(iteration));
}
const median = (key) => runs.map((run) => run[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
const keys = [
    'elapsed_ms',
    'throughput_per_second',
    'peak_rss_bytes',
    'peak_heap_bytes',
    'event_loop_delay_mean_ms',
    'event_loop_delay_p99_ms',
    'peak_active_handles',
    'report_batch_count',
];
const summary = Object.fromEntries(keys.map((key) => [key, median(key)]));

process.stdout.write(`${JSON.stringify({
    environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
    },
    sku: skuBudgets,
    note: 'Synthetic setTimeout I/O only - not a substitute for container SKU soak tests with real HTTP/DNS/DB.',
    runs,
    median: summary,
}, null, 2)}\n`);
