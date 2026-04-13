import net from 'net';
import {
    DEFAULT_MONITOR_TIMEOUT_S,
    MAX_MONITOR_TIMEOUT_S,
    MIN_MONITOR_TIMEOUT_S,
    DEFAULT_MAX_RESPONSE_TIME_MS,
} from '../lib/constants.js';

/**
 * Perform TCP port check on a monitor
 */
export async function checkTcp(monitor) {
    const result = {
        monitor_id: monitor.id,
        is_success: false,
        response_time_ms: null,
        error_message: null,
        error_type: null,
    };

    return new Promise((resolve) => {
        const startTime = Date.now();
        let resolved = false;

        // Extract host and port
        let host = monitor.url;
        let port = monitor.port || 80;

        try {
            const url = new URL(monitor.url);
            host = url.hostname;
            port = monitor.port || parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80);
        } catch {
            // url is likely just an IP or hostname
        }

        const socket = new net.Socket();
        const timeoutS = Math.min(Math.max(MIN_MONITOR_TIMEOUT_S, monitor.timeout || DEFAULT_MONITOR_TIMEOUT_S), MAX_MONITOR_TIMEOUT_S);
        const timeout = timeoutS * 1000;

        // Named handlers for clean removal
        const onConnect = () => {
            result.response_time_ms = Date.now() - startTime;

            const maxResponseTime = monitor.success_criteria?.max_response_time || DEFAULT_MAX_RESPONSE_TIME_MS;
            if (result.response_time_ms > maxResponseTime) {
                result.is_success = false;
                result.error_type = 'response_time';
                result.error_message = `Connection time ${result.response_time_ms}ms exceeds limit ${maxResponseTime}ms`;
            } else {
                result.is_success = true;
            }

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
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(timeout);
        socket.on('connect', onConnect);
        socket.on('timeout', onTimeout);
        socket.on('error', onError);
        socket.connect(port, host);
    });
}

export default checkTcp;
