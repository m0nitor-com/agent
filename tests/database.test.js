import { describe, expect, it, vi } from 'vitest';

const mysqlState = vi.hoisted(() => ({
    destroy: vi.fn(),
    createConnection: vi.fn(),
    rejectPending: null,
}));

const pgState = vi.hoisted(() => ({
    Client: vi.fn(),
}));

vi.mock('../src/lib/config.js', () => ({
    config: { IP_FAMILY: 'auto' },
}));

vi.mock('mysql2', () => ({
    createConnection: mysqlState.createConnection,
}));

vi.mock('pg', () => ({
    Client: pgState.Client,
}));

const {
    checkDatabase,
    validateDatabaseMonitor,
    validateReadOnlyQuery,
} = await import('../src/checks/database.js');
const { executeWithContext } = await import('../src/lib/execution-context.js');

const logger = { warn: vi.fn() };

function mysqlMonitor(overrides = {}) {
    return validateDatabaseMonitor({
        id: 1,
        type: 'mysql',
        timeout: 2,
        family: 'ipv4',
        private_probe: true,
        allow_private_target: true,
        database_config: {
            host: '8.8.8.8',
            port: 3306,
            database: 'app',
            username: 'monitor',
            password: 'top-secret-password',
            collect_metrics: false,
            ...overrides,
        },
    });
}

function postgresMonitor(overrides = {}) {
    return validateDatabaseMonitor({
        id: 2,
        type: 'postgresql',
        timeout: 2,
        family: 'ipv4',
        private_probe: true,
        allow_private_target: true,
        database_config: {
            host: '8.8.8.8',
            port: 5432,
            database: 'app',
            username: 'monitor',
            password: 'secret',
            collect_metrics: false,
            ...overrides,
        },
    });
}

describe('database checks', () => {
    it('accepts only bounded read-only single statements', () => {
        expect(validateReadOnlyQuery('SELECT 1;')).toBe('SELECT 1');
        expect(validateReadOnlyQuery('WITH x AS (SELECT 1) SELECT * FROM x')).toBeTruthy();
        expect(validateReadOnlyQuery('SELECT 1; DELETE FROM users')).toBeNull();
        expect(validateReadOnlyQuery('SELECT * FROM users -- bypass')).toBeNull();
        expect(validateReadOnlyQuery('WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x')).toBeNull();
        expect(validateReadOnlyQuery('UPDATE users SET admin = 1')).toBeNull();
        expect(validateReadOnlyQuery('SELECT 1'.padEnd(5000, ' '))).toBeNull();
    });

    it('rejects SELECT INTO, OUTFILE, DUMPFILE, locking, and RETURNING forms', () => {
        expect(validateReadOnlyQuery('SELECT id, name INTO audit_copy FROM users')).toBeNull();
        expect(validateReadOnlyQuery("SELECT * FROM users INTO OUTFILE '/tmp/users.csv'")).toBeNull();
        expect(validateReadOnlyQuery("SELECT * FROM users INTO DUMPFILE '/tmp/users.bin'")).toBeNull();
        expect(validateReadOnlyQuery('SELECT * FROM users FOR UPDATE')).toBeNull();
        expect(validateReadOnlyQuery('SELECT * FROM users FOR SHARE')).toBeNull();
        expect(validateReadOnlyQuery('SELECT * FROM users LOCK IN SHARE MODE')).toBeNull();
        expect(validateReadOnlyQuery('WITH x AS (SELECT 1 AS id) SELECT id FROM x RETURNING id')).toBeNull();
    });

    it('rejects optional queries unless the payload is explicitly private-probe scoped', () => {
        const monitor = {
            id: 1,
            type: 'postgresql',
            private_probe: false,
            database_config: {
                host: 'db.example.com',
                username: 'monitor',
                password: 'secret',
                query: 'SELECT 1',
            },
        };
        expect(validateDatabaseMonitor(monitor)).toBeNull();
    });

    it('sets MySQL session transaction read-only before health and optional queries', async () => {
        const query = vi.fn()
            .mockResolvedValueOnce([[], []])
            .mockResolvedValueOnce([[{ health: 1 }], []])
            .mockResolvedValueOnce([[{ value: 1 }], []]);
        mysqlState.createConnection.mockReturnValue({
            destroy: vi.fn(),
            promise: () => ({
                connect: vi.fn().mockResolvedValue(undefined),
                query,
            }),
        });

        const result = await executeWithContext({
            monitor: mysqlMonitor({ query: 'SELECT 1 AS value', collect_metrics: false }),
            handler: checkDatabase,
            timeoutMs: 500,
            logger,
        });

        expect(result.is_success).toBe(true);
        expect(query.mock.calls[0][0].sql).toBe('SET SESSION TRANSACTION READ ONLY');
        expect(query.mock.calls[1][0].sql).toBe('SELECT 1 AS health');
        expect(query.mock.calls[2][0].sql).toContain('SELECT 1 AS value');
    });

    it('sets PostgreSQL default_transaction_read_only before health checks', async () => {
        const query = vi.fn()
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ health: 1 }] });
        const end = vi.fn().mockResolvedValue(undefined);
        pgState.Client.mockImplementation(function MockClient() {
            return {
                connect: vi.fn().mockResolvedValue(undefined),
                query,
                end,
                connection: { stream: { destroy: vi.fn() } },
            };
        });

        const result = await executeWithContext({
            monitor: postgresMonitor(),
            handler: checkDatabase,
            timeoutMs: 500,
            logger,
        });

        expect(result.is_success).toBe(true);
        expect(query.mock.calls[0][0]).toBe('SET default_transaction_read_only = on');
        expect(query.mock.calls[1][0]).toBe('SELECT 1 AS health');
    });

    it('destroys a MySQL client when the execution deadline aborts a pending query', async () => {
        mysqlState.destroy.mockReset();
        const query = vi.fn(() => new Promise((_, reject) => {
            mysqlState.rejectPending = reject;
        }));
        mysqlState.createConnection.mockReturnValue({
            connect: vi.fn((callback) => callback(null)),
            promise: () => ({
                connect: vi.fn().mockResolvedValue(undefined),
                query,
            }),
            query: vi.fn(() => new Promise((_, reject) => {
                mysqlState.rejectPending = reject;
            })),
            destroy: () => {
                mysqlState.destroy();
                mysqlState.rejectPending?.(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
            },
        });

        const result = await executeWithContext({
            monitor: mysqlMonitor(),
            handler: checkDatabase,
            timeoutMs: 25,
            logger,
        });

        expect(result.error_type).toBe('timeout');
        expect(mysqlState.destroy).toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('top-secret-password');
    });

    it('destroys a MySQL socket when cancellation happens during connect', async () => {
        mysqlState.destroy.mockReset();
        let rejectConnect;
        mysqlState.createConnection.mockReturnValue({
            promise: () => ({
                connect: vi.fn(() => new Promise((_, reject) => {
                    rejectConnect = reject;
                })),
            }),
            destroy: () => {
                mysqlState.destroy();
                rejectConnect?.(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
            },
        });

        const result = await executeWithContext({
            monitor: mysqlMonitor(),
            handler: checkDatabase,
            timeoutMs: 25,
            logger,
        });

        expect(result.error_type).toBe('timeout');
        expect(mysqlState.destroy).toHaveBeenCalledTimes(1);
    });

    it('returns generic authentication errors without driver messages or passwords', async () => {
        const authError = Object.assign(
            new Error('Access denied for top-secret-password'),
            { code: 'ER_ACCESS_DENIED_ERROR' },
        );
        const destroy = vi.fn();
        mysqlState.createConnection.mockReturnValueOnce({
            destroy,
            promise: () => ({
                connect: vi.fn().mockRejectedValue(authError),
            }),
        });
        const result = await executeWithContext({
            monitor: mysqlMonitor(),
            handler: checkDatabase,
            timeoutMs: 100,
            logger,
        });

        expect(result).toMatchObject({
            is_success: false,
            error_type: 'authentication',
            error_message: 'Database authentication failed',
        });
        expect(JSON.stringify(result)).not.toContain('top-secret-password');
    });
});
