import { spawn } from 'node:child_process';
import { config as appConfig } from '../lib/config.js';
import { resolveAndCheck, effectiveFamily, familyLabel } from '../lib/ssrf.js';

const MAX_DIAGNOSTIC_OUTPUT_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_HOPS = 64;
const MAX_DIAGNOSTIC_CYCLES = 10;

function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
}

export function validateDiagnostic(raw) {
    if (!raw || typeof raw !== 'object' || raw.id == null) return null;
    const type = String(raw.type || '').toLowerCase();
    if (!['mtr', 'traceroute'].includes(type)) return null;
    if (typeof raw.url !== 'string' || raw.url.trim() === '' || raw.url.length > 255) return null;

    const diagnostic = raw.diagnostic && typeof raw.diagnostic === 'object'
        ? raw.diagnostic
        : {};
    const protocol = diagnostic.protocol === 'tcp' ? 'tcp' : 'icmp';
    const port = protocol === 'tcp'
        ? boundedInteger(diagnostic.port ?? raw.port, 443, 1, 65535)
        : null;

    return {
        ...raw,
        type,
        url: raw.url.trim(),
        timeout: boundedInteger(raw.timeout, 20, 2, 60),
        family: raw.family === 'ipv6' ? 'ipv6' : 'ipv4',
        diagnostic: {
            protocol,
            port,
            cycles: boundedInteger(diagnostic.cycles, 3, 1, MAX_DIAGNOSTIC_CYCLES),
            max_hops: boundedInteger(diagnostic.max_hops, 30, 1, MAX_DIAGNOSTIC_HOPS),
        },
    };
}

export function buildDiagnosticCommand(monitor, target, platform = process.platform) {
    if (platform === 'win32') return null;
    const familyFlag = monitor.family === 'ipv6' ? '-6' : '-4';
    const options = monitor.diagnostic;

    if (monitor.type === 'mtr') {
        const args = [
            familyFlag,
            '--report',
            '--json',
            '--no-dns',
            '--report-cycles',
            String(options.cycles),
            '--max-ttl',
            String(options.max_hops),
        ];
        if (options.protocol === 'tcp') {
            args.push('--tcp', '--port', String(options.port));
        }
        args.push(target);
        return { binary: 'mtr', args };
    }

    const args = [
        familyFlag,
        '-n',
        '-m',
        String(options.max_hops),
        '-q',
        String(options.cycles),
        '-w',
        '2',
    ];
    if (options.protocol === 'tcp') {
        args.push('-T', '-p', String(options.port));
    }
    args.push(target);
    return { binary: 'traceroute', args };
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function parseMtrOutput(output) {
    try {
        const parsed = JSON.parse(output);
        const hubs = parsed?.report?.hubs;
        if (!Array.isArray(hubs)) return [];
        return hubs.slice(0, MAX_DIAGNOSTIC_HOPS).map((hop, index) => ({
            hop: boundedInteger(hop.count, index + 1, 1, MAX_DIAGNOSTIC_HOPS),
            host: typeof hop.host === 'string' ? hop.host.slice(0, 255) : null,
            loss_percent: finiteNumber(hop['Loss%']),
            sent: finiteNumber(hop.Snt),
            last_ms: finiteNumber(hop.Last),
            avg_ms: finiteNumber(hop.Avg),
            best_ms: finiteNumber(hop.Best),
            worst_ms: finiteNumber(hop.Wrst),
            stddev_ms: finiteNumber(hop.StDev),
            timeout: hop.host === '???',
        }));
    } catch {
        return [];
    }
}

export function parseTracerouteOutput(output) {
    const hops = [];
    for (const line of output.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match) continue;
        const hopNumber = boundedInteger(match[1], 0, 1, MAX_DIAGNOSTIC_HOPS);
        if (hopNumber === 0) continue;
        const remainder = match[2];
        const hostMatch = /([0-9a-fA-F:.]+|\*)/.exec(remainder);
        const samples = [...remainder.matchAll(/([\d.]+)\s*ms/gi)]
            .map((sample) => Number(sample[1]))
            .filter(Number.isFinite)
            .slice(0, MAX_DIAGNOSTIC_CYCLES);
        const avg = samples.length > 0
            ? samples.reduce((sum, value) => sum + value, 0) / samples.length
            : null;
        hops.push({
            hop: hopNumber,
            host: hostMatch?.[1] === '*' ? null : hostMatch?.[1] || null,
            samples_ms: samples,
            avg_ms: avg === null ? null : Number(avg.toFixed(3)),
            timeout: samples.length === 0,
        });
        if (hops.length >= MAX_DIAGNOSTIC_HOPS) break;
    }
    return hops;
}

function runCommand(command, context) {
    return new Promise((resolve) => {
        const child = spawn(command.binary, command.args, {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = Buffer.alloc(0);
        let outputTruncated = false;
        let spawnError = null;
        let aborted = false;
        let settled = false;

        const append = (chunk) => {
            if (output.length >= MAX_DIAGNOSTIC_OUTPUT_BYTES) {
                outputTruncated = true;
                if (!child.killed) child.kill('SIGKILL');
                return;
            }
            const remaining = MAX_DIAGNOSTIC_OUTPUT_BYTES - output.length;
            output = Buffer.concat([output, chunk.subarray(0, remaining)]);
            if (chunk.length > remaining) {
                outputTruncated = true;
                if (!child.killed) child.kill('SIGKILL');
            }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);

        const unregisterCleanup = context.cleanup.add(() => {
            if (!child.killed) child.kill('SIGKILL');
        });
        const onAbort = () => {
            aborted = true;
            if (!child.killed) child.kill('SIGKILL');
        };
        const finish = (code, signal) => {
            if (settled) return;
            settled = true;
            context.signal.removeEventListener('abort', onAbort);
            unregisterCleanup();
            resolve({
                code,
                signal,
                output: output.toString('utf8'),
                outputTruncated,
                spawnError,
                aborted,
            });
        };

        context.signal.addEventListener('abort', onAbort, { once: true });
        child.once('error', (error) => {
            spawnError = error;
        });
        child.once('close', finish);
        if (context.signal.aborted) onAbort();
    });
}

export async function checkDiagnostic(monitor, context) {
    const started = Date.now();
    const family = effectiveFamily(monitor.family, appConfig.IP_FAMILY) || 'ipv4';
    const allowPrivate = monitor.allow_private_target === true
        && monitor.private_probe === true;
    const resolved = await resolveAndCheck(monitor.url, {
        family,
        allowPrivate,
        signal: context.signal,
    });

    if (!resolved.ok) {
        return {
            monitor_id: monitor.id,
            is_success: false,
            response_time_ms: Date.now() - started,
            family,
            error_type: resolved.reason === 'blocked_private_target'
                ? 'blocked_private_target'
                : 'dns',
            error_message: resolved.reason === 'blocked_private_target'
                ? 'Diagnostic target is private or reserved'
                : 'Diagnostic target could not be resolved',
            diagnostic: {
                state: 'unsupported',
                tool: monitor.type,
                hops: [],
            },
        };
    }

    const command = buildDiagnosticCommand(monitor, resolved.ip);
    if (!command) {
        return {
            monitor_id: monitor.id,
            is_success: false,
            response_time_ms: Date.now() - started,
            resolved_ip: resolved.ip,
            family: familyLabel(resolved.family),
            error_type: 'unsupported',
            error_message: 'This platform does not provide the requested diagnostic tool',
            diagnostic: {
                state: 'unsupported',
                tool: monitor.type,
                hops: [],
            },
        };
    }

    const processResult = await runCommand(command, context);
    const hops = monitor.type === 'mtr'
        ? parseMtrOutput(processResult.output)
        : parseTracerouteOutput(processResult.output);
    let state = 'complete';
    if (processResult.spawnError?.code === 'ENOENT') state = 'unsupported';
    else if (processResult.aborted) state = 'timeout';
    else if (processResult.outputTruncated || processResult.code !== 0) state = hops.length > 0 ? 'partial' : 'unsupported';
    if (processResult.aborted) context.allowAbortSettlement();

    const success = state === 'complete' || state === 'partial';
    return {
        monitor_id: monitor.id,
        is_success: success,
        response_time_ms: Date.now() - started,
        resolved_ip: resolved.ip,
        family: familyLabel(resolved.family),
        error_type: state === 'complete' ? null : `diagnostic_${state}`,
        error_message: state === 'complete'
            ? null
            : state === 'partial'
                ? 'Diagnostic completed with partial results'
                : state === 'timeout'
                    ? 'Diagnostic timed out'
                    : 'Diagnostic tool or mode is unsupported',
        diagnostic: {
            state,
            tool: monitor.type,
            protocol: monitor.diagnostic.protocol,
            cycles: monitor.diagnostic.cycles,
            max_hops: monitor.diagnostic.max_hops,
            output_truncated: processResult.outputTruncated,
            exit_code: Number.isInteger(processResult.code) ? processResult.code : null,
            hops,
        },
    };
}

export default checkDiagnostic;
