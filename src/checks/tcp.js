import net from 'net';

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

        const done = () => {
            if (resolved) return;
            resolved = true;
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };

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
        const timeout = (monitor.timeout || 10) * 1000;

        socket.setTimeout(timeout);

        socket.connect(port, host, () => {
            result.response_time_ms = Date.now() - startTime;

            // Check response time limit
            const maxResponseTime = monitor.success_criteria?.max_response_time || 30000;
            if (result.response_time_ms > maxResponseTime) {
                result.is_success = false;
                result.error_type = 'response_time';
                result.error_message = `Connection time ${result.response_time_ms}ms exceeds limit ${maxResponseTime}ms`;
            } else {
                result.is_success = true;
            }

            done();
        });

        socket.on('timeout', () => {
            result.response_time_ms = Date.now() - startTime;
            result.is_success = false;
            result.error_type = 'timeout';
            result.error_message = `Connection to ${host}:${port} timed out after ${monitor.timeout || 10}s`;
            done();
        });

        socket.on('error', (error) => {
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
        });
    });
}

export default checkTcp;
