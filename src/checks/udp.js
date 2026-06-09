import dgram from 'dgram';
import { logger } from '../lib/logger.js';
import { config as appConfig } from '../lib/config.js';
import { resolveAndCheck } from '../lib/ssrf.js';

/**
 * Perform UDP port check on a monitor
 */
export async function checkUdp(monitor) {
    const startTime = Date.now();
    const result = {
        monitor_id: monitor.id,
        is_success: false,
        response_time_ms: null,
        error_message: null,
        error_type: null,
    };

    // Extract host and port up-front so we can run the SSRF pre-flight.
    let host = monitor.url;
    let port = monitor.port || 53; // Default to DNS port if not specified

    try {
        if (host.includes('://')) {
            const url = new URL(monitor.url);
            host = url.hostname;
            port = monitor.port || parseInt(url.port) || 53;
        }
    } catch {
        // host is likely just an IP or hostname
    }

    const allowPrivate = monitor.allow_private_target === true || appConfig.ALLOW_PRIVATE_TARGETS === true;
    if (!allowPrivate) {
        const check = await resolveAndCheck(host);
        if (!check.ok && check.reason === 'blocked_private_target') {
            result.response_time_ms = Date.now() - startTime;
            result.error_type = 'blocked_private_target';
            result.error_message = `Target ${host} resolves to a private/reserved IP (${check.ip})`;
            logger.warn({ monitor_id: monitor.id, host, ip: check.ip }, '[UDP] Blocked private target');
            return result;
        }
    }

    return new Promise((resolve) => {
        let resolved = false;

        const client = dgram.createSocket('udp4');
        const timeout = (monitor.timeout || 10) * 1000;

        const done = () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            try { client.close(); } catch { /* already closed */ }
            resolve(result);
        };

        const timer = setTimeout(() => {
            // For UDP, no ICMP unreachable within the timeout = port is likely open.
            // This is the standard behavior for UDP port probing: absence of error
            // indicates the port accepted or silently dropped the packet.
            result.is_success = true;
            result.response_time_ms = Date.now() - startTime;
            done();
        }, timeout);

        client.on('error', (error) => {
            result.response_time_ms = Date.now() - startTime;
            result.is_success = false;

            const code = error.code || '';

            if (code === 'ENOTFOUND') {
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
            } else if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
                result.error_type = 'connection';
                result.error_message = `Port ${port} on ${host} is closed (ICMP unreachable)`;
            } else if (code === 'EACCES' || code === 'EPERM') {
                result.error_type = 'permission';
                result.error_message = `Permission denied sending UDP packet to ${host}:${port}`;
            } else {
                result.error_type = 'unknown';
                result.error_message = error.message || 'UDP check failed';
            }

            done();
        });

        client.on('message', (_msg, _rinfo) => {
            result.is_success = true;
            result.response_time_ms = Date.now() - startTime;
            done();
        });

        // Send a small dummy packet to trigger ICMP Unreachable if port is closed
        const message = Buffer.from('ping');
        client.send(message, port, host, (error) => {
            if (error) {
                result.response_time_ms = Date.now() - startTime;
                result.is_success = false;

                const code = error.code || '';
                if (code === 'ENOTFOUND') {
                    result.error_type = 'dns';
                    result.error_message = `DNS resolution failed for ${host}`;
                } else {
                    result.error_type = 'connection';
                    result.error_message = error.message || `Failed to send UDP packet to ${host}:${port}`;
                }

                done();
            }
            // If sent successfully, we wait for a message or timeout
        });
    });
}

export default checkUdp;
