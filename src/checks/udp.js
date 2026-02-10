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
            // For UDP, timeout often means "UP" if no ICMP error was received,
            // but for a strict check we treat it as "no response".
            // However, most monitors treat "no response" as successful if it's just a port probe
            // unless a specific payload/response is defined.
            // Let's be conservative and treat timeout as success if no error occurred,
            // or let's just mark it as success for now since UDP is non-guaranteed.

            // Actually, if we send a packet and get nothing, we don't know if it's up or down.
            // But if we get ECONNREFUSED, it's definitely down.
            // Many simple monitors mark UDP as "UP" if they don't get an ICMP unreachable.

            result.is_success = true;
            result.response_time_ms = Date.now() - startTime;
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
