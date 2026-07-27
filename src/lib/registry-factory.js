import { CheckRegistry } from './check-registry.js';
import { validateMonitor } from './validator.js';
import checkHttp from '../checks/http.js';
import checkPing from '../checks/ping.js';
import checkTcp from '../checks/tcp.js';
import checkDns from '../checks/dns.js';
import checkUdp from '../checks/udp.js';
import checkDiagnostic, { validateDiagnostic } from '../checks/diagnostic.js';
import checkDatabase, { validateDatabaseMonitor } from '../checks/database.js';

function validateExisting(raw) {
    const normalized = raw?.type === 'dns' && raw.dns_record_type
        ? { ...raw, method: raw.dns_record_type }
        : raw;
    return validateMonitor(normalized);
}

export function createRegistry() {
    return new CheckRegistry()
        .register('http', {
            capability: 'http',
            budget: 'network',
            validate: validateExisting,
            handler: checkHttp,
        })
        .register('https', {
            capability: 'https',
            budget: 'network',
            validate: validateExisting,
            handler: checkHttp,
        })
        .register('ping', {
            capability: 'ping',
            budget: 'network',
            validate: validateExisting,
            handler: checkPing,
        })
        .register('tcp', {
            capability: 'tcp',
            budget: 'network',
            validate: validateExisting,
            handler: checkTcp,
        })
        .register('ssh', {
            capability: 'ssh',
            budget: 'network',
            validate: validateExisting,
            handler: checkTcp,
        })
        .register('udp', {
            capability: 'udp',
            budget: 'network',
            validate: validateExisting,
            handler: checkUdp,
        })
        .register('dns', {
            capability: 'dns',
            budget: 'network',
            validate: validateExisting,
            handler: checkDns,
        })
        .register('mtr', {
            capability: 'mtr',
            budget: 'diagnostic',
            validate: validateDiagnostic,
            handler: checkDiagnostic,
        })
        .register('traceroute', {
            capability: 'traceroute',
            budget: 'diagnostic',
            validate: validateDiagnostic,
            handler: checkDiagnostic,
        })
        .register('mysql', {
            capability: 'mysql',
            budget: 'database',
            validate: validateDatabaseMonitor,
            handler: checkDatabase,
        })
        .register('postgresql', {
            capability: 'postgresql',
            budget: 'database',
            validate: validateDatabaseMonitor,
            handler: checkDatabase,
        })
        .register('redis', {
            capability: 'redis',
            budget: 'database',
            validate: validateDatabaseMonitor,
            handler: checkDatabase,
        });
}
