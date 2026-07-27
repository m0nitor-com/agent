const VALID_BUDGETS = new Set(['network', 'database', 'diagnostic']);

export class CheckRegistry {
    constructor() {
        this.entries = new Map();
    }

    register(type, definition) {
        const normalizedType = String(type || '').toLowerCase();
        if (!normalizedType || this.entries.has(normalizedType)) {
            throw new Error(`Check type "${normalizedType}" is invalid or already registered`);
        }
        if (typeof definition?.handler !== 'function') {
            throw new TypeError(`Check type "${normalizedType}" requires a handler`);
        }
        if (!VALID_BUDGETS.has(definition.budget)) {
            throw new Error(`Check type "${normalizedType}" has an invalid budget`);
        }

        this.entries.set(normalizedType, Object.freeze({
            type: normalizedType,
            capability: definition.capability || normalizedType,
            budget: definition.budget,
            handler: definition.handler,
            validate: definition.validate,
        }));
        return this;
    }

    alias(aliasType, registeredType) {
        const entry = this.get(registeredType);
        if (!entry) {
            throw new Error(`Cannot alias unknown check type "${registeredType}"`);
        }
        return this.register(aliasType, {
            ...entry,
            capability: aliasType,
        });
    }

    get(type) {
        return this.entries.get(String(type || '').toLowerCase()) || null;
    }

    has(type) {
        return this.get(type) !== null;
    }

    capabilities() {
        return [...new Set([...this.entries.values()].map((entry) => entry.capability))].sort();
    }

    budgetFor(type) {
        return this.get(type)?.budget || 'network';
    }

    validate(raw) {
        const entry = this.get(raw?.type);
        if (!entry) {
            return {
                ok: false,
                error: `Monitor type ${String(raw?.type || '')} is not supported`,
            };
        }

        if (typeof entry.validate !== 'function') {
            return { ok: true, monitor: raw, entry };
        }

        const monitor = entry.validate(raw);
        return monitor
            ? { ok: true, monitor, entry }
            : { ok: false, error: 'Monitor configuration is invalid' };
    }
}
