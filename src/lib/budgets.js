const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function round(value) {
    return Math.round(value);
}

/**
 * Named SKU profiles for common probe shapes.
 * Prefer these when detected resources match the class.
 */
export const SKU_PROFILES = Object.freeze({
    'sku-1c1g': Object.freeze({
        id: 'sku-1c1g',
        label: '1c/1GB',
        total: 16,
        network: 13,
        database: 2,
        diagnostic: 1,
        httpMaxSockets: 6,
        httpMaxFreeSockets: 2,
        queueEntries: 500,
        queueBytes: 4 * MiB,
        batchSize: 50,
        batchBytes: 512 * KiB,
        softRssBytes: 350 * MiB,
        hardRssBytes: 550 * MiB,
    }),
    'sku-2c2g': Object.freeze({
        id: 'sku-2c2g',
        label: '2c/2GB',
        total: 28,
        network: 24,
        database: 3,
        diagnostic: 1,
        httpMaxSockets: 12,
        httpMaxFreeSockets: 3,
        queueEntries: 1000,
        queueBytes: 8 * MiB,
        batchSize: 100,
        batchBytes: 1 * MiB,
        softRssBytes: 700 * MiB,
        hardRssBytes: Math.round(1.2 * GiB),
    }),
    'sku-2c4g': Object.freeze({
        id: 'sku-2c4g',
        label: '2c/4GB',
        total: 40,
        network: 34,
        database: 4,
        diagnostic: 2,
        httpMaxSockets: 16,
        httpMaxFreeSockets: 4,
        queueEntries: 1500,
        queueBytes: 12 * MiB,
        batchSize: 100,
        batchBytes: 1 * MiB,
        softRssBytes: Math.round(1.5 * GiB),
        hardRssBytes: Math.round(2.8 * GiB),
    }),
});

/**
 * Classify detected resources into a named SKU when close to a known class.
 */
export function classifySku(cpus, memoryGiB) {
    if (cpus <= 1.25 && memoryGiB < 1.75) return 'sku-1c1g';
    if (cpus <= 2.5 && memoryGiB < 2.75) return 'sku-2c2g';
    if (cpus <= 2.5 && memoryGiB < 5) return 'sku-2c4g';
    return null;
}

/**
 * Formula-derived budgets when resources do not match a named SKU.
 *
 * total = clamp(round(8 + 8*cpus + 4*memGiB), 8, 64)
 * db    = clamp(round(cpus), 1, 4)
 * diag  = memGiB >= 3.5 ? 2 : 1
 * network = max(4, total - db - diag)
 * http_max_sockets = clamp(ceil(network * 0.5), 4, 24)
 */
export function computeFormulaBudgets(cpus, memoryGiB, memoryBytes) {
    const safeCpus = Math.max(0.25, cpus);
    const safeMemGiB = Math.max(0.25, memoryGiB);
    const total = clamp(round(8 + 8 * safeCpus + 4 * safeMemGiB), 8, 64);
    const database = clamp(round(safeCpus), 1, 4);
    const diagnostic = safeMemGiB >= 3.5 ? 2 : 1;
    const network = Math.max(4, total - database - diagnostic);
    const httpMaxSockets = clamp(Math.ceil(network * 0.5), 4, 24);
    const httpMaxFreeSockets = clamp(Math.ceil(httpMaxSockets / 4), 1, 4);
    const queueEntries = clamp(round(safeMemGiB * 400), 250, 2000);
    const queueBytes = clamp(round(safeMemGiB * 4) * MiB, 2 * MiB, 16 * MiB);
    const batchSize = safeMemGiB >= 1.5 ? 100 : 50;
    const batchBytes = safeMemGiB >= 1.5 ? 1 * MiB : 512 * KiB;
    const softRssBytes = Math.round(memoryBytes * 0.35);
    const hardRssBytes = Math.round(memoryBytes * 0.7);

    return {
        id: 'formula',
        label: `${safeCpus.toFixed(2)}c/${safeMemGiB.toFixed(2)}GiB`,
        total,
        network,
        database,
        diagnostic,
        httpMaxSockets,
        httpMaxFreeSockets,
        queueEntries,
        queueBytes,
        batchSize,
        batchBytes,
        softRssBytes,
        hardRssBytes,
    };
}

/**
 * Normalize ENV overrides so network/db/diag stay within total and
 * http sockets stay coupled to the network budget.
 */
export function normalizeBudgets(input) {
    const total = clamp(round(Number(input.total) || 8), 1, 64);
    const database = clamp(round(Number(input.database) || 1), 1, Math.min(4, total));
    const diagnostic = clamp(round(Number(input.diagnostic) || 1), 1, Math.min(4, total));
    let network = clamp(round(Number(input.network) || 4), 1, total);
    if (network + database + diagnostic > total) {
        network = Math.max(1, total - database - diagnostic);
    }
    const httpMaxSockets = clamp(
        round(Number(input.httpMaxSockets) || Math.ceil(network * 0.5)),
        4,
        Math.min(24, Math.max(4, network)),
    );
    const httpMaxFreeSockets = clamp(
        round(Number(input.httpMaxFreeSockets) || Math.ceil(httpMaxSockets / 4)),
        1,
        Math.min(4, httpMaxSockets),
    );

    return {
        ...input,
        total,
        network,
        database,
        diagnostic,
        httpMaxSockets,
        httpMaxFreeSockets,
        queueEntries: clamp(round(Number(input.queueEntries) || 500), 50, 5000),
        queueBytes: Math.max(64 * KiB, round(Number(input.queueBytes) || 4 * MiB)),
        batchSize: clamp(round(Number(input.batchSize) || 50), 1, 500),
        batchBytes: Math.max(16 * KiB, round(Number(input.batchBytes) || 512 * KiB)),
        softRssBytes: Math.max(64 * MiB, round(Number(input.softRssBytes) || 350 * MiB)),
        hardRssBytes: Math.max(128 * MiB, round(Number(input.hardRssBytes) || 550 * MiB)),
    };
}

/**
 * Compute budgets from detected resources, preferring named SKU profiles.
 */
export function computeBudgets(resources, options = {}) {
    const cpus = resources.cpus;
    const memoryGiB = resources.memoryGiB;
    const memoryBytes = resources.memoryBytes;
    const forcedSku = options.sku && SKU_PROFILES[options.sku] ? options.sku : null;
    const skuId = forcedSku || classifySku(cpus, memoryGiB);
    const base = skuId
        ? { ...SKU_PROFILES[skuId] }
        : computeFormulaBudgets(cpus, memoryGiB, memoryBytes);

    return {
        ...normalizeBudgets(base),
        sku: skuId || 'formula',
        detected: {
            cpus,
            memoryBytes,
            memoryGiB,
            source: resources.source,
        },
    };
}
