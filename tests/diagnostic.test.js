import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/config.js', () => ({
    config: { IP_FAMILY: 'auto' },
}));
import {
    buildDiagnosticCommand,
    parseMtrOutput,
    parseTracerouteOutput,
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
});
