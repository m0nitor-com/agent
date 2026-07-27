const BUDGET_ORDER = ['network', 'database', 'diagnostic'];

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
        this.cursor = 0;
        this.paused = false;
        this._wake = null;
    }

    setLimits({ total, network, database, diagnostic } = {}) {
        if (total != null) this.limits.total = Math.max(1, total);
        if (network != null) this.limits.network = Math.max(1, network);
        if (database != null) this.limits.database = Math.max(1, database);
        if (diagnostic != null) this.limits.diagnostic = Math.max(1, diagnostic);
        this._wake?.();
    }

    setPaused(paused) {
        this.paused = paused === true;
        if (!this.paused) this._wake?.();
    }

    async run(items, budgetFor, worker, options = {}) {
        if (!Array.isArray(items) || items.length === 0) return [];

        const onResult = typeof options.onResult === 'function' ? options.onResult : null;
        const retainResults = options.retainResults === true || !onResult;

        const queues = {
            network: [],
            database: [],
            diagnostic: [],
        };
        items.forEach((item, index) => {
            const budget = BUDGET_ORDER.includes(budgetFor(item)) ? budgetFor(item) : 'network';
            queues[budget].push({ item, index, budget });
        });

        const results = retainResults ? new Array(items.length) : null;
        let remaining = items.length;
        let retainedCount = 0;

        return new Promise((resolve) => {
            const notify = () => {
                this.onStateChange?.({
                    active: { ...this.active },
                    queued: queues.network.length + queues.database.length + queues.diagnostic.length,
                    retainedResults: retainedCount,
                    paused: this.paused,
                });
            };

            const nextRunnable = () => {
                if (this.paused) return null;
                for (let offset = 0; offset < BUDGET_ORDER.length; offset++) {
                    const position = (this.cursor + offset) % BUDGET_ORDER.length;
                    const budget = BUDGET_ORDER[position];
                    if (queues[budget].length > 0 && this.active[budget] < this.limits[budget]) {
                        this.cursor = (position + 1) % BUDGET_ORDER.length;
                        return queues[budget].shift();
                    }
                }
                return null;
            };

            const settle = (job, value) => {
                if (results) {
                    results[job.index] = value;
                    retainedCount++;
                }
                try {
                    onResult?.(value, job.index);
                } catch {
                    // Callback failures must not stall the scheduler pump.
                }
            };

            const pump = () => {
                while (!this.paused && this.active.total < this.limits.total) {
                    const job = nextRunnable();
                    if (!job) break;

                    this.active.total++;
                    this.active[job.budget]++;
                    notify();

                    Promise.resolve()
                        .then(() => worker(job.item))
                        .then((result) => {
                            settle(job, result);
                        }, (error) => {
                            settle(job, { error });
                        })
                        .finally(() => {
                            this.active.total--;
                            this.active[job.budget]--;
                            remaining--;
                            notify();
                            if (remaining === 0) {
                                this._wake = null;
                                resolve(results || []);
                            } else {
                                pump();
                            }
                        });
                }
                notify();
            };

            this._wake = pump;
            pump();
        });
    }
}
