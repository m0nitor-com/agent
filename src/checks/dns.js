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
    const maxResponseTime = monitor.success_criteria?.max_response_time || 30000;

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

        // Build dns_info with resolved records
        const dnsInfo = {
            record_type: recordType,
            records: results.slice(0, 10), // Cap at 10 records to limit payload
            server: customServer || 'system',
            record_count: results.length,
        };

        // Check response time limit
        if (responseTime > maxResponseTime) {
            return {
                monitor_id: monitor.id,
                is_success: false,
                response_time_ms: responseTime,
                error_type: 'response_time',
                error_message: `DNS resolution took ${responseTime}ms (limit: ${maxResponseTime}ms)`,
                dns_info: dnsInfo,
            };
        }

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
                    dns_info: dnsInfo,
                };
            }
        }

        return {
            monitor_id: monitor.id,
            is_success: true,
            response_time_ms: responseTime,
            dns_info: dnsInfo,
        };

    } catch (error) {
        const responseTime = Date.now() - start;
        const code = error.code || '';

        let errorType = 'dns_error';
        let errorMessage = `DNS Error: ${error.message}`;

        if (code === 'ENOTFOUND' || code === 'ENODATA') {
            errorType = 'dns';
            errorMessage = `No ${recordType} records found for ${hostname}`;
        } else if (code === 'ESERVFAIL') {
            errorType = 'dns_servfail';
            errorMessage = `DNS server failed to resolve ${hostname} (SERVFAIL)`;
        } else if (code === 'ETIMEOUT' || code === 'TIMEOUT') {
            errorType = 'timeout';
            errorMessage = `DNS resolution timed out for ${hostname}`;
        } else if (code === 'EREFUSED' || code === 'ECONNREFUSED') {
            errorType = 'dns_refused';
            errorMessage = `DNS query was refused${customServer ? ` by ${customServer}` : ''}`;
        } else if (code === 'EFORMERR') {
            errorType = 'dns_format';
            errorMessage = `DNS query format error for ${hostname}`;
        } else if (code === 'ENOTIMP') {
            errorType = 'dns_not_implemented';
            errorMessage = `DNS server does not support ${recordType} queries`;
        }

        return {
            monitor_id: monitor.id,
            is_success: false,
            response_time_ms: responseTime,
            error_type: errorType,
            error_message: errorMessage,
        };
    }
}

export default checkDns;
