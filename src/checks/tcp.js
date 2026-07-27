import net from 'net';
import { logger } from '../lib/logger.js';
import { config as appConfig } from '../lib/config.js';
import { resolveAndCheck, effectiveFamily, familyLabel } from '../lib/ssrf.js';
import {
    DEFAULT_MONITOR_TIMEOUT_S,
    MAX_MONITOR_TIMEOUT_S,
    MIN_MONITOR_TIMEOUT_S,
} from '../lib/constants.js';

/**
 * Parse "[ipv6]:port" or "[ipv6]" literals that new URL() cannot handle when the
 * target has no scheme. Returns null when the input is not a bracketed literal.
 */
function parseBracketedLiteral(raw) {
    const m = /^\[([0-9a-fA-F:]+)\](?::(\d+))?$/.exec(String(raw).trim());
    if (!m) return null;
    return { host: m[1], port: m[2] ? parseInt(m[2], 10) : null };
}

/**
 * Perform TCP port check on a monitor
 */
export async function checkTcp(monitor, context = null) {
    const startTime = Date.now();
    const result = {
        monitor_id: monitor.id,
        is_success: false,
        response_time_ms: null,
        error_message: null,
        error_type: null,
        resolved_ip: null,
        family: null,
    };

    // Extract host and port up-front so we can run the SSRF pre-flight.
    let host = monitor.url;
    let port = monitor.port || 80;

    try {
        const url = new URL(monitor.url);
        host = url.hostname;
        port = monitor.port || parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80);
    } catch {
        // Not a URL - may be a bare host, or a bracketed IPv6 literal like [::1]:443.
        const bracketed = parseBracketedLiteral(monitor.url);
        if (bracketed) {
            host = bracketed.host;
            port = monitor.port || bracketed.port || 80;
        }
    }

    const allowPrivate = monitor.allow_private_target === true || appConfig.ALLOW_PRIVATE_TARGETS === true;
    const family = effectiveFamily(monitor.family, appConfig.IP_FAMILY);

    // Resolve + SSRF pre-flight, and pin the validated IP so the socket cannot be
    // re-resolved to a different (private) address between check and connect.
    const check = await resolveAndCheck(host, { family, allowPrivate, signal: context?.signal });
    if (!check.ok) {
        result.response_time_ms = Date.now() - startTime;
        if (check.reason === 'blocked_private_target') {
            result.error_type = 'blocked_private_target';
            result.error_message = `Target ${host} resolves to a private/reserved IP (${check.ip})`;
            logger.warn({ monitor_id: monitor.id, host, ip: check.ip }, '[TCP] Blocked private target');
        } else if (check.reason === 'family_unavailable') {
            result.error_type = 'family_unavailable';
            result.error_message = `No ${family} address available for ${host}`;
        } else {
            const code = check.error?.code || '';
            result.error_type = code === 'EAI_AGAIN' ? 'dns_temporary' : 'dns';
            result.error_message = `DNS resolution failed for ${host}`;
        }
        return result;
    }

    const target = check.ip;
    result.resolved_ip = target;
    result.family = familyLabel(check.family);

    return new Promise((resolve) => {
        let resolved = false;

        const socket = new net.Socket();
        const unregisterCleanup = context?.cleanup.add(() => socket.destroy());
        const timeoutS = Math.min(Math.max(MIN_MONITOR_TIMEOUT_S, monitor.timeout || DEFAULT_MONITOR_TIMEOUT_S), MAX_MONITOR_TIMEOUT_S);
        const timeout = timeoutS * 1000;

        // Named handlers for clean removal
        const onConnect = () => {
            result.response_time_ms = Date.now() - startTime;
            result.is_success = true;
            done();
        };

        const onTimeout = () => {
            result.response_time_ms = Date.now() - startTime;
            result.is_success = false;
            result.error_type = 'timeout';
            result.error_message = `Connection to ${host}:${port} timed out after ${timeoutS}s`;
            done();
        };

        const onError = (error) => {
            result.response_time_ms = Date.now() - startTime;
            result.is_success = false;

            const code = error.code || '';

            if (code === 'ECONNREFUSED') {
                result.error_type = 'connection';
                result.error_message = `Connection refused on ${host}:${port}`;
            } else if (code === 'ECONNRESET') {
                result.error_type = 'connection_reset';
                result.error_message = `Connection to ${host}:${port} was reset by the server`;
            } else if (code === 'ENOTFOUND') {
                result.error_type = 'dns';
                result.error_message = `DNS resolution failed for ${host}`;
            } else if (code === 'EAI_AGAIN') {
                result.error_type = 'dns_temporary';
                result.error_message = `Temporary DNS failure for ${host}`;
            } else if (code === 'EHOSTUNREACH') {
                result.error_type = 'host_unreachable';
                result.error_message = `Host ${host} is unreachable`;
            } else if (code === 'ENETUNREACH') {
                result.error_type = 'network_unreachable';
                result.error_message = `Network is unreachable for ${host}`;
            } else if (code === 'ETIMEDOUT') {
                result.error_type = 'timeout';
                result.error_message = `Connection to ${host}:${port} timed out`;
            } else if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
                result.error_type = 'connection_reset';
                result.error_message = `Connection to ${host}:${port} was closed unexpectedly`;
            } else {
                result.error_type = 'unknown';
                result.error_message = error.message || 'TCP connection failed';
            }

            done();
        };

        const done = () => {
            if (resolved) return;
            resolved = true;
            // Remove specific listeners instead of removeAllListeners()
            socket.off('connect', onConnect);
            socket.off('timeout', onTimeout);
            socket.off('error', onError);
            context?.signal.removeEventListener('abort', onAbort);
            unregisterCleanup?.();
            socket.destroy();
            resolve(result);
        };

        const onAbort = () => done();

        socket.setTimeout(timeout);
        socket.on('connect', onConnect);
        socket.on('timeout', onTimeout);
        socket.on('error', onError);
        context?.signal.addEventListener('abort', onAbort, { once: true });
        if (context?.signal.aborted) {
            onAbort();
            return;
        }
        // Connect to the validated IP literal (family is implied by the address).
        socket.connect({ host: target, port, family: check.family });
    });
}

export default checkTcp;
