/**
 * Min-heap of checks keyed by their due time (console clock, epoch ms).
 *
 * One timer is armed for the earliest entry and re-armed whenever the head
 * changes. No polling loop: an idle agent with nothing due has exactly one
 * pending timer.
 */
export class DueSchedule {
    constructor({ clock, onDue, setTimer = setTimeout, clearTimer = clearTimeout }) {
        this.clock = clock;
        this.onDue = onDue;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.heap = [];
        this.timer = null;
        this.timerAt = null;
        this.stopped = false;
    }

    get size() {
        return this.heap.length;
    }

    add(dueAt, item) {
        if (this.stopped) return;
        this.heap.push({ dueAt, item });
        this.siftUp(this.heap.length - 1);
        this.arm();
    }

    /** Remove and return every entry due at or before the console time. */
    takeDue(serverNow = this.clock.serverNow()) {
        const due = [];
        while (this.heap.length > 0 && this.heap[0].dueAt <= serverNow) {
            due.push(this.pop());
        }
        return due;
    }

    arm() {
        if (this.stopped || this.heap.length === 0) {
            this.disarm();
            return;
        }
        const head = this.heap[0].dueAt;
        if (this.timer && this.timerAt === head) return;
        this.disarm();
        this.timerAt = head;
        const delay = Math.max(0, Math.min(this.clock.delayUntil(head), 2_147_483_647));
        this.timer = this.setTimer(() => this.fire(), delay);
        this.timer?.unref?.();
    }

    disarm() {
        if (this.timer) this.clearTimer(this.timer);
        this.timer = null;
        this.timerAt = null;
    }

    fire() {
        this.timer = null;
        this.timerAt = null;
        if (this.stopped) return;
        const due = this.takeDue();
        if (due.length > 0) {
            try {
                this.onDue(due);
            } catch {
                // A callback failure must not stop the schedule.
            }
        }
        this.arm();
    }

    /** Drop everything (shutdown). Returns the dropped entries. */
    clear() {
        const dropped = this.heap.splice(0);
        this.disarm();
        return dropped;
    }

    stop() {
        this.stopped = true;
        return this.clear();
    }

    pop() {
        const top = this.heap[0];
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.siftDown(0);
        }
        return top;
    }

    siftUp(index) {
        const heap = this.heap;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (heap[parent].dueAt <= heap[index].dueAt) break;
            [heap[parent], heap[index]] = [heap[index], heap[parent]];
            index = parent;
        }
    }

    siftDown(index) {
        const heap = this.heap;
        const length = heap.length;
        for (;;) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;
            if (left < length && heap[left].dueAt < heap[smallest].dueAt) smallest = left;
            if (right < length && heap[right].dueAt < heap[smallest].dueAt) smallest = right;
            if (smallest === index) return;
            [heap[smallest], heap[index]] = [heap[index], heap[smallest]];
            index = smallest;
        }
    }
}

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
}
