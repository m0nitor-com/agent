import ping from 'ping';

/**
 * Perform ICMP ping check on a monitor
 */
export async function checkPing(monitor) {
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

        const isWindows = process.platform === 'win32';
        const pingResult = await ping.promise.probe(host, {
            timeout: monitor.timeout || 10,
            extra: [isWindows ? '-n' : '-c', '3'],
        });

        if (pingResult.alive) {
            result.is_success = true;
            result.response_time_ms = Math.round(parseFloat(pingResult.avg) || parseFloat(pingResult.time));
        } else {
            result.is_success = false;
            result.error_type = 'connection';
            result.error_message = `Host ${host} is not responding to ping`;
        }

    } catch (error) {
        result.is_success = false;
        result.error_type = 'unknown';
        result.error_message = error.message || 'Ping failed';
    }

    return result;
}

export default checkPing;
