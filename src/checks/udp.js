import dgram from 'dgram';

/**
 * Perform UDP port check on a monitor
 */
export async function checkUdp(monitor) {
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

        const client = dgram.createSocket('udp4');
        const timeout = (monitor.timeout || 10) * 1000;
        let isHandled = false;

        const cleanup = () => {
            if (isHandled) return;
            isHandled = true;
            client.close();
            clearTimeout(timer);
        };

        const timer = setTimeout(() => {
            if (isHandled) return;
            // For UDP, no ICMP unreachable within the timeout = port is likely open.
            // This is the standard behavior for UDP port probing: absence of error
            // indicates the port accepted or silently dropped the packet.
            // We mark it as success but flag it as a timeout-based result.
            result.is_success = true;
            result.response_time_ms = Date.now() - startTime;
            result.error_message = 'No ICMP unreachable received (UDP timeout – assumed open)';
            cleanup();
            resolve(result);
        }, timeout);

        client.on('error', (error) => {
            result.is_success = false;
            result.response_time_ms = Date.now() - startTime;
            result.error_type = 'connection';
            result.error_message = error.message || 'UDP check failed';
            cleanup();
            resolve(result);
        });

        client.on('message', (msg, rinfo) => {
            result.is_success = true;
            result.response_time_ms = Date.now() - startTime;
            cleanup();
            resolve(result);
        });

        // Send a small dummy packet to trigger ICMP Unreachable if port is closed
        const message = Buffer.from('ping');
        client.send(message, port, host, (error) => {
            if (error) {
                result.is_success = false;
                result.response_time_ms = Date.now() - startTime;
                result.error_type = 'connection';
                result.error_message = error.message;
                cleanup();
                resolve(result);
            }
            // If sent successfully, we wait for a message or timeout
        });
    });
}

export default checkUdp;
