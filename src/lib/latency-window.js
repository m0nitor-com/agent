/** Running percentiles over the most recent samples (fixed ring). */
export class LatencyWindow {
    constructor(capacity = 1024) {
        this.capacity = capacity;
        this.values = [];
        this.cursor = 0;
    }

    push(value) {
        if (!Number.isFinite(value)) return;
        if (this.values.length < this.capacity) {
            this.values.push(value);
        } else {
            this.values[this.cursor] = value;
            this.cursor = (this.cursor + 1) % this.capacity;
        }
    }

    percentiles() {
        if (this.values.length === 0) return { p50: null, p95: null, p99: null, samples: 0 };
        const sorted = [...this.values].sort((a, b) => a - b);
        const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))];
        return { p50: at(0.5), p95: at(0.95), p99: at(0.99), samples: sorted.length };
    }

    max() {
        return this.values.length === 0 ? null : Math.max(...this.values);
    }
}
