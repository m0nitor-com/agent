import dns from 'dns/promises';
import net from 'net';

/**
 * Execute a DNS check
 * @param {Object} monitor
 * @returns {Promise<Object>}
 */
async function checkDns(monitor) {
    const start = Date.now();
    const hostname = monitor.url.replace(/^https?:\/\//, '').split('/')[0];
    const recordType = (monitor.method || 'A').toUpperCase();
    const expectedValue = monitor.success_criteria?.expected_value || null;
    const customServer = monitor.success_criteria?.dns_server || null;

    try {
        let results = [];
        const resolver = new dns.Resolver();

        if (customServer) {
            if (net.isIP(customServer)) {
                resolver.setServers([customServer]);
            } else {
                // If it's a hostname, resolve it first using default DNS
                const ips = await dns.resolve4(customServer);
                if (ips.length > 0) {
                    resolver.setServers(ips);
                } else {
                    throw new Error(`Could not resolve custom DNS server hostname: ${customServer}`);
                }
            }
        }

        switch (recordType) {
            case 'A':
                results = await resolver.resolve4(hostname);
                break;
            case 'AAAA':
                results = await resolver.resolve6(hostname);
                break;
            case 'MX':
                results = await resolver.resolveMx(hostname);
                results = results.map(r => `${r.exchange} (${r.priority})`);
                break;
            case 'TXT':
                results = await resolver.resolveTxt(hostname);
                results = results.flat();
                break;
            case 'NS':
                results = await resolver.resolveNs(hostname);
                break;
            case 'CNAME':
                results = await resolver.resolveCname(hostname);
                break;
            case 'SOA':
                const soa = await resolver.resolveSoa(hostname);
                results = [`${soa.nsname} ${soa.hostmaster} ${soa.serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minttl}`];
                break;
            case 'SRV':
                const srv = await resolver.resolveSrv(hostname);
                results = srv.map(s => `${s.name} ${s.port} ${s.priority} ${s.weight}`);
                break;
            case 'PTR':
                results = await resolver.reverse(hostname);
                break;
            default:
                throw new Error(`Unsupported record type: ${recordType}`);
        }

        const responseTime = Date.now() - start;

        // Check against expected value if provided
        if (expectedValue) {
            const match = results.some(val =>
                String(val).toLowerCase().includes(expectedValue.toLowerCase())
            );

            if (!match) {
                return {
                    monitor_id: monitor.id,
                    is_success: false,
                    response_time_ms: responseTime,
                    error_type: 'dns_mismatch',
                    error_message: `Expected value "${expectedValue}" not found in results: ${results.join(', ')}`,
                };
            }
        }

        return {
            monitor_id: monitor.id,
            is_success: true,
            response_time_ms: responseTime,
            message: `Resolved ${recordType} records: ${results.slice(0, 3).join(', ')}${results.length > 3 ? '...' : ''}`,
        };

    } catch (error) {
        const responseTime = Date.now() - start;
        return {
            monitor_id: monitor.id,
            is_success: false,
            response_time_ms: responseTime,
            error_type: 'dns_error',
            error_message: error.code === 'ENOTFOUND' ? `Hostname not found: ${hostname}` : `DNS Error: ${error.message}`,
        };
    }
}

export default checkDns;
