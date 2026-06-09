import ping from 'ping';
import { logger } from '../lib/logger.js';
import { config as appConfig } from '../lib/config.js';
import { resolveAndCheck } from '../lib/ssrf.js';

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
        if (!allowPrivate) {
            const check = await resolveAndCheck(host);
            if (!check.ok && check.reason === 'blocked_private_target') {
                result.response_time_ms = Date.now() - startTime;
                result.error_type = 'blocked_private_target';
                result.error_message = `Target ${host} resolves to a private/reserved IP (${check.ip})`;
                logger.warn({ monitor_id: monitor.id, host, ip: check.ip }, '[PING] Blocked private target');
                return result;
            }
        }

        const isWindows = process.platform === 'win32';
        const pingResult = await ping.promise.probe(host, {
            timeout: monitor.timeout || 10,
            extra: [isWindows ? '-n' : '-c', '3'],
        });

        if (pingResult.alive) {
            // Parse response time with NaN-safe fallback
            const avg = parseFloat(pingResult.avg);
            const time = parseFloat(pingResult.time);
            result.response_time_ms = !isNaN(avg) ? Math.round(avg) : (!isNaN(time) ? Math.round(time) : 0);
            result.is_success = true;

            // Check response time limit
            const maxResponseTime = monitor.success_criteria?.max_response_time || 30000;
            if (result.response_time_ms > maxResponseTime) {
                result.is_success = false;
                result.error_type = 'response_time';
                result.error_message = `Ping time ${result.response_time_ms}ms exceeds limit ${maxResponseTime}ms`;
            }
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
