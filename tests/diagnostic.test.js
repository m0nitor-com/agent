import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/config.js', () => ({
    config: { IP_FAMILY: 'auto' },
}));
import {
    buildDiagnosticCommand,
    normalizeHostname,
    parseMtrOutput,
    parseTracerouteOutput,
    resolveHopHostnames,
    validateDiagnostic,
} from '../src/checks/diagnostic.js';

describe('diagnostic checks', () => {
    it('normalizes and bounds every diagnostic option', () => {
        const monitor = validateDiagnostic({
            id: -1,
            type: 'mtr',
            url: 'example.com',
            family: 'ipv6',
            timeout: 999,
            diagnostic: {
                protocol: 'tcp',
                port: 99999,
                cycles: 999,
                max_hops: 999,
            },
        });

        expect(monitor.timeout).toBe(60);
        expect(monitor.diagnostic).toEqual({
            protocol: 'tcp',
            port: 65535,
            cycles: 10,
            max_hops: 64,
        });
    });

    it('builds fixed MTR arguments without a shell string', () => {
        const monitor = validateDiagnostic({
            id: -2,
            type: 'mtr',
            url: 'example.com; touch /tmp/pwned',
            family: 'ipv4',
            diagnostic: { protocol: 'tcp', port: 443, cycles: 3, max_hops: 20 },
        });
        const command = buildDiagnosticCommand(monitor, '203.0.113.10', 'linux');

        expect(command.binary).toBe('mtr');
        expect(command.args.at(-1)).toBe('203.0.113.10');
        expect(command.args).not.toContain(monitor.url);
        expect(command.args).toContain('--tcp');
        expect(command.args).toContain('443');
    });

    it('builds bounded TCP traceroute arguments', () => {
        const monitor = validateDiagnostic({
            id: -3,
            type: 'traceroute',
            url: 'example.com',
            family: 'ipv6',
            diagnostic: { protocol: 'tcp', port: 8443, cycles: 2, max_hops: 30 },
        });
        const command = buildDiagnosticCommand(monitor, '2001:4860:4860::8888', 'linux');

        expect(command).toEqual({
            binary: 'traceroute',
            args: ['-6', '-n', '-m', '30', '-q', '2', '-w', '2', '-T', '-p', '8443', '2001:4860:4860::8888'],
        });
    });

    it('parses structured MTR hops and truncates unbounded input', () => {
        const hubs = Array.from({ length: 80 }, (_, index) => ({
            count: index + 1,
            host: `192.0.2.${index + 1}`,
            'Loss%': 0,
            Snt: 3,
            Last: 1,
            Avg: 2,
            Best: 1,
            Wrst: 3,
            StDev: 0.5,
        }));
        const hops = parseMtrOutput(JSON.stringify({ report: { hubs } }));

        expect(hops).toHaveLength(64);
        expect(hops[0]).toMatchObject({ hop: 1, avg_ms: 2, sent: 3 });
    });

    it('parses traceroute hop samples and timeouts', () => {
        const hops = parseTracerouteOutput([
            'traceroute to example.com (93.184.216.34), 30 hops max',
            ' 1  192.0.2.1  1.100 ms  1.300 ms',
            ' 2  * * *',
            ' 3  93.184.216.34  10.000 ms',
        ].join('\n'));

        expect(hops).toEqual([
            {
                hop: 1,
                host: '192.0.2.1',
                samples_ms: [1.1, 1.3],
                avg_ms: 1.2,
                timeout: false,
            },
            {
                hop: 2,
                host: null,
                samples_ms: [],
                avg_ms: null,
                timeout: true,
            },
            {
                hop: 3,
                host: '93.184.216.34',
                samples_ms: [10],
                avg_ms: 10,
                timeout: false,
            },
        ]);
    });
    it('attaches reverse DNS names to answering hops and keeps the address as host', async () => {
        const reverse = vi.fn(async (address) => {
            if (address === '192.0.2.1') return ['ae1.fra.example.net.'];
            throw Object.assign(new Error('no PTR'), { code: 'ENOTFOUND' });
        });
        const hops = await resolveHopHostnames([
            { hop: 1, host: '192.0.2.1', timeout: false },
            { hop: 2, host: null, timeout: true },
            { hop: 3, host: '203.0.113.10', timeout: false },
            { hop: 4, host: '192.0.2.1', timeout: false },
        ], { reverse });

        expect(reverse).toHaveBeenCalledTimes(2);
        expect(hops).toEqual([
            { hop: 1, host: '192.0.2.1', hostname: 'ae1.fra.example.net', timeout: false },
            { hop: 2, host: null, timeout: true },
            { hop: 3, host: '203.0.113.10', timeout: false },
            { hop: 4, host: '192.0.2.1', hostname: 'ae1.fra.example.net', timeout: false },
        ]);
    });

    it('returns the hops unnamed once the lookup budget runs out', async () => {
        const reverse = vi.fn(() => new Promise(() => {}));
        const hops = [{ hop: 1, host: '192.0.2.1', timeout: false }];

        await expect(resolveHopHostnames(hops, { reverse, budgetMs: 10 })).resolves.toEqual(hops);
        await expect(resolveHopHostnames(hops, { reverse, budgetMs: 0 })).resolves.toEqual(hops);
        expect(reverse).toHaveBeenCalledTimes(1);
    });

    it('stops waiting for lookups when the check is aborted', async () => {
        const controller = new AbortController();
        const reverse = vi.fn(() => new Promise(() => {}));
        const pending = resolveHopHostnames([{ hop: 1, host: '192.0.2.1' }], {
            reverse,
            budgetMs: 60_000,
            signal: controller.signal,
        });
        controller.abort();

        await expect(pending).resolves.toEqual([{ hop: 1, host: '192.0.2.1' }]);
    });

    it('only keeps PTR answers that are plain DNS names', () => {
        expect(normalizeHostname('Core1.Example.NET.', '192.0.2.1')).toBe('core1.example.net');
        expect(normalizeHostname('192.0.2.1', '192.0.2.1')).toBeNull();
        expect(normalizeHostname('<script>alert(1)</script>', '192.0.2.1')).toBeNull();
        expect(normalizeHostname('bad name.example', '192.0.2.1')).toBeNull();
        expect(normalizeHostname('-edge.example', '192.0.2.1')).toBeNull();
        expect(normalizeHostname(`${'a'.repeat(64)}.example`, '192.0.2.1')).toBeNull();
        expect(normalizeHostname(null, '192.0.2.1')).toBeNull();
    });
});
