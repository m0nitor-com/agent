const BUDGET_ORDER = ['network', 'database', 'diagnostic'];

/**
 * One shared work queue for every caller.
 *
 * The main poll and the on-demand fast lane both submit work here and share
 * the same concurrency limits. A single pump drains all queues, so a finished
 * job from one caller always lets queued work from another caller start. The
 * old per-run pump could leave a run waiting forever when another run held
 * every slot.
 */
export class FairScheduler {
    constructor({ total, network, database, diagnostic, onStateChange = null }) {
        this.limits = {
            total: Math.max(1, total),
            network: Math.max(1, network),
            database: Math.max(1, database),
            diagnostic: Math.max(1, diagnostic),
        };
        this.onStateChange = onStateChange;
        this.active = { total: 0, network: 0, database: 0, diagnostic: 0 };
        this.queues = { network: [], database: [], diagnostic: [] };
        this.cursor = 0;
        this.paused = false;
    }

    get queued() {
        return this.queues.network.length + this.queues.database.length + this.queues.diagnostic.length;
    }

    setLimits({ total, network, database, diagnostic } = {}) {
        if (total != null) this.limits.total = Math.max(1, total);
        if (network != null) this.limits.network = Math.max(1, network);
        if (database != null) this.limits.database = Math.max(1, database);
        if (diagnostic != null) this.limits.diagnostic = Math.max(1, diagnostic);
        this.pump();
    }

    setPaused(paused) {
        this.paused = paused === true;
        if (!this.paused) this.pump();
    }

    notify(retainedResults = 0) {
        this.onStateChange?.({
            active: { ...this.active },
            queued: this.queued,
            retainedResults,
            paused: this.paused,
        });
    }

    /**
     * Run items through the shared queue. Resolves once every item of this
     * call has settled. Other calls keep running alongside it.
     */
    run(items, budgetFor, worker, options = {}) {
        if (!Array.isArray(items) || items.length === 0) return Promise.resolve([]);

        const onResult = typeof options.onResult === 'function' ? options.onResult : null;
        const retainResults = options.retainResults === true || !onResult;
        const results = retainResults ? new Array(items.length) : null;
        let remaining = items.length;
        let retainedCount = 0;

        return new Promise((resolve) => {
            const settle = (index, value) => {
                if (results) {
                    results[index] = value;
                    retainedCount++;
                }
                try {
                    onResult?.(value, index);
                } catch {
                    // A callback failure must not stall the pump.
                }
                remaining--;
                if (remaining === 0) resolve(results || []);
            };

            items.forEach((item, index) => {
                const raw = budgetFor(item);
                const budget = BUDGET_ORDER.includes(raw) ? raw : 'network';
                this.queues[budget].push({ item, index, budget, worker, settle });
            });
            this.notify(retainedCount);
            this.pump();
        });
    }

    nextRunnable() {
        if (this.paused) return null;
        for (let offset = 0; offset < BUDGET_ORDER.length; offset++) {
            const position = (this.cursor + offset) % BUDGET_ORDER.length;
            const budget = BUDGET_ORDER[position];
            if (this.queues[budget].length > 0 && this.active[budget] < this.limits[budget]) {
                this.cursor = (position + 1) % BUDGET_ORDER.length;
                return this.queues[budget].shift();
            }
        }
        return null;
    }

    pump() {
        while (!this.paused && this.active.total < this.limits.total) {
            const job = this.nextRunnable();
            if (!job) break;

            this.active.total++;
            this.active[job.budget]++;
            this.notify();

            Promise.resolve()
                .then(() => job.worker(job.item))
                .then((result) => job.settle(job.index, result), (error) => job.settle(job.index, { error }))
                .finally(() => {
                    this.active.total--;
                    this.active[job.budget]--;
                    this.notify();
                    this.pump();
                });
        }
        this.notify();
    }
}
