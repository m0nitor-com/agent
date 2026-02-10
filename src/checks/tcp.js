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
            result.is_success = true;
            result.response_time_ms = Date.now() - startTime;
            socket.destroy();
            resolve(result);
        });

        socket.on('timeout', () => {
            result.is_success = false;
            result.response_time_ms = Date.now() - startTime;
            result.error_type = 'timeout';
            result.error_message = `Connection to ${host}:${port} timed out`;
            socket.destroy();
            resolve(result);
        });

        socket.on('error', (error) => {
            result.is_success = false;
            result.response_time_ms = Date.now() - startTime;

            if (error.code === 'ECONNREFUSED') {
                result.error_type = 'connection';
                result.error_message = `Connection refused on ${host}:${port}`;
            } else if (error.code === 'ENOTFOUND') {
                result.error_type = 'dns';
                result.error_message = `DNS resolution failed for ${host}`;
            } else {
                result.error_type = 'unknown';
                result.error_message = error.message || 'TCP connection failed';
            }

            socket.destroy();
            resolve(result);
        });
    });
}

export default checkTcp;
