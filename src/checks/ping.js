import ping from 'ping';
import { logger } from '../lib/logger.js';
import { config as appConfig } from '../lib/config.js';
import { resolveAndCheck, effectiveFamily, familyLabel } from '../lib/ssrf.js';
import { PING_COUNT } from '../lib/constants.js';

/**
 * Perform ICMP ping check on a monitor
 */
export async function checkPing(monitor) {
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

    try {
        // Extract host from URL or use directly
        let host = monitor.url;
        try {
            const url = new URL(monitor.url);
            host = url.hostname;
        } catch {
            // url is likely just an IP or hostname
        }

        const allowPrivate = monitor.allow_private_target === true || appConfig.ALLOW_PRIVATE_TARGETS === true;
        const family = effectiveFamily(monitor.family, appConfig.IP_FAMILY);

        // Resolve + SSRF pre-flight; ping the validated IP directly so the correct
        // IP family (and ICMPv6) is used and the reported IP is exact.
        const check = await resolveAndCheck(host, { family, allowPrivate });
        if (!check.ok) {
            result.response_time_ms = Date.now() - startTime;
            if (check.reason === 'blocked_private_target') {
                result.error_type = 'blocked_private_target';
                result.error_message = `Target ${host} resolves to a private/reserved IP (${check.ip})`;
                logger.warn({ monitor_id: monitor.id, host, ip: check.ip }, '[PING] Blocked private target');
            } else if (check.reason === 'family_unavailable') {
                result.error_type = 'family_unavailable';
                result.error_message = `No ${family} address available for ${host}`;
            } else {
                result.error_type = 'dns';
                result.error_message = `DNS resolution failed for ${host}`;
            }
            return result;
        }

        const target = check.ip;
        result.resolved_ip = target;
        result.family = familyLabel(check.family);

        const isWindows = process.platform === 'win32';
        const pingResult = await ping.promise.probe(target, {
            timeout: monitor.timeout || 10,
            v6: check.family === 6,
            extra: [isWindows ? '-n' : '-c', String(PING_COUNT)],
        });

        if (pingResult.alive) {
            // Parse response time with NaN-safe fallback
            const avg = parseFloat(pingResult.avg);
            const time = parseFloat(pingResult.time);
            result.response_time_ms = !isNaN(avg) ? Math.round(avg) : (!isNaN(time) ? Math.round(time) : 0);
            result.is_success = true;
        } else {
            result.is_success = false;

            // Determine specific error based on ping output
            const output = (pingResult.output || '').toLowerCase();
            if (output.includes('network is unreachable') || output.includes('network unreachable')) {
                result.error_type = 'network_unreachable';
                result.error_message = `Network is unreachable for ${host}`;
            } else if (output.includes('unreachable') || output.includes('host unreachable')) {
                result.error_type = 'host_unreachable';
                result.error_message = `Host ${host} is unreachable`;
            } else if (output.includes('timed out') || output.includes('timeout')) {
                result.error_type = 'timeout';
                result.error_message = `Ping to ${host} timed out`;
            } else if (output.includes('unknown host') || output.includes('could not find host')) {
                result.error_type = 'dns';
                result.error_message = `DNS resolution failed for ${host}`;
            } else if (output.includes('permission denied') || output.includes('operation not permitted') || output.includes('are you root')) {
                result.error_type = 'permission';
                result.error_message = 'Probe lacks permission to send ICMP. The agent needs the NET_RAW capability (or net.ipv4.ping_group_range) to run ping checks.';
            } else {
                result.error_type = 'connection';
                result.error_message = `Host ${host} is not responding to ping`;
            }
        }

    } catch (error) {
        result.is_success = false;

        if (error.message?.includes('not found') || error.message?.includes('ENOTFOUND')) {
            result.error_type = 'dns';
            result.error_message = `DNS resolution failed for ${monitor.url}`;
        } else {
            result.error_type = 'unknown';
            result.error_message = error.message || 'Ping failed';
        }
    }

    return result;
}

export default checkPing;
