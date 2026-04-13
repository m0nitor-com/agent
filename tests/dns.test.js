import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolver = {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
    resolveMx: vi.fn(),
    resolveTxt: vi.fn(),
    resolveNs: vi.fn(),
    resolveCname: vi.fn(),
    resolveSoa: vi.fn(),
    resolveSrv: vi.fn(),
    reverse: vi.fn(),
    setServers: vi.fn(),
};

vi.mock('dns/promises', () => ({
    default: {
        Resolver: class MockResolver {
            constructor() {
                Object.assign(this, mockResolver);
            }
            setServers(servers) { mockResolver.setServers(servers); }
        },
        resolve4: vi.fn(),
    },
}));

vi.mock('net', () => ({
    default: {
        isIP: vi.fn((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v) ? 4 : 0),
    },
}));

// Clear the resolver cache between tests by re-importing
let checkDns;

beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamic import to get fresh module - but resolver cache persists.
    // We just reset mock return values each test.
    if (!checkDns) {
        const mod = await import('../src/checks/dns.js');
        checkDns = mod.default;
    }
});

describe('checkDns', () => {
    const baseMonitor = {
        id: 1,
        url: 'https://example.com/path',
        method: 'A',
        success_criteria: { max_response_time: 30000 },
    };

    it('resolves A records successfully', async () => {
        mockResolver.resolve4.mockResolvedValue(['93.184.216.34']);

        const result = await checkDns(baseMonitor);
        expect(result.is_success).toBe(true);
        expect(result.monitor_id).toBe(1);
        expect(result.dns_info.record_type).toBe('A');
        expect(result.dns_info.records).toEqual(['93.184.216.34']);
    });

    it('resolves AAAA records', async () => {
        mockResolver.resolve6.mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']);

        const result = await checkDns({ ...baseMonitor, method: 'AAAA' });
        expect(result.is_success).toBe(true);
        expect(result.dns_info.record_type).toBe('AAAA');
    });

    it('resolves MX records', async () => {
        mockResolver.resolveMx.mockResolvedValue([
            { exchange: 'mail.example.com', priority: 10 },
        ]);

        const result = await checkDns({ ...baseMonitor, method: 'MX' });
        expect(result.is_success).toBe(true);
        expect(result.dns_info.records[0]).toContain('mail.example.com');
    });

    it('resolves TXT records', async () => {
        mockResolver.resolveTxt.mockResolvedValue([['v=spf1 include:example.com']]);

        const result = await checkDns({ ...baseMonitor, method: 'TXT' });
        expect(result.is_success).toBe(true);
    });

    it('resolves NS records', async () => {
        mockResolver.resolveNs.mockResolvedValue(['ns1.example.com']);

        const result = await checkDns({ ...baseMonitor, method: 'NS' });
        expect(result.is_success).toBe(true);
    });

    it('resolves CNAME records', async () => {
        mockResolver.resolveCname.mockResolvedValue(['alias.example.com']);

        const result = await checkDns({ ...baseMonitor, method: 'CNAME' });
        expect(result.is_success).toBe(true);
    });

    it('resolves SOA records', async () => {
        mockResolver.resolveSoa.mockResolvedValue({
            nsname: 'ns1.example.com',
            hostmaster: 'admin.example.com',
            serial: 2024010101,
            refresh: 3600,
            retry: 900,
            expire: 604800,
            minttl: 86400,
        });

        const result = await checkDns({ ...baseMonitor, method: 'SOA' });
        expect(result.is_success).toBe(true);
        expect(result.dns_info.records[0]).toContain('ns1.example.com');
    });

    it('resolves SRV records', async () => {
        mockResolver.resolveSrv.mockResolvedValue([
            { name: 'sip.example.com', port: 5060, priority: 10, weight: 100 },
        ]);

        const result = await checkDns({ ...baseMonitor, method: 'SRV' });
        expect(result.is_success).toBe(true);
    });

    it('fails on expected value mismatch', async () => {
        mockResolver.resolve4.mockResolvedValue(['1.2.3.4']);

        const result = await checkDns({
            ...baseMonitor,
            success_criteria: { expected_value: '5.6.7.8', max_response_time: 30000 },
        });
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns_mismatch');
    });

    it('succeeds when expected value matches', async () => {
        mockResolver.resolve4.mockResolvedValue(['1.2.3.4']);

        const result = await checkDns({
            ...baseMonitor,
            success_criteria: { expected_value: '1.2.3.4', max_response_time: 30000 },
        });
        expect(result.is_success).toBe(true);
    });

    it('fails on response time exceeding limit', async () => {
        mockResolver.resolve4.mockImplementation(() =>
            new Promise(resolve => setTimeout(() => resolve(['1.2.3.4']), 50))
        );

        const result = await checkDns({
            ...baseMonitor,
            success_criteria: { max_response_time: -1 },
        });
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('response_time');
    });

    it('handles ENOTFOUND error', async () => {
        const err = new Error('queryA ENOTFOUND');
        err.code = 'ENOTFOUND';
        mockResolver.resolve4.mockRejectedValue(err);

        const result = await checkDns(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns');
    });

    it('handles ESERVFAIL error', async () => {
        const err = new Error('queryA ESERVFAIL');
        err.code = 'ESERVFAIL';
        mockResolver.resolve4.mockRejectedValue(err);

        const result = await checkDns(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns_servfail');
    });

    it('handles ETIMEOUT error', async () => {
        const err = new Error('queryA ETIMEOUT');
        err.code = 'ETIMEOUT';
        mockResolver.resolve4.mockRejectedValue(err);

        const result = await checkDns(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('timeout');
    });

    it('handles EREFUSED error', async () => {
        const err = new Error('queryA EREFUSED');
        err.code = 'EREFUSED';
        mockResolver.resolve4.mockRejectedValue(err);

        const result = await checkDns(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns_refused');
    });

    it('handles unsupported record type', async () => {
        const result = await checkDns({ ...baseMonitor, method: 'INVALID' });
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns_error');
    });

    it('uses custom DNS server when provided as IP', async () => {
        mockResolver.resolve4.mockResolvedValue(['1.2.3.4']);

        const result = await checkDns({
            ...baseMonitor,
            success_criteria: { dns_server: '8.8.8.8', max_response_time: 30000 },
        });
        expect(result.is_success).toBe(true);
    });

    it('limits records to MAX_DNS_RECORDS', async () => {
        const manyRecords = Array.from({ length: 20 }, (_, i) => `1.2.3.${i}`);
        mockResolver.resolve4.mockResolvedValue(manyRecords);

        const result = await checkDns(baseMonitor);
        expect(result.dns_info.records.length).toBe(10);
        expect(result.dns_info.record_count).toBe(20);
    });

    it('strips protocol from url for hostname', async () => {
        mockResolver.resolve4.mockResolvedValue(['1.2.3.4']);

        const result = await checkDns({ ...baseMonitor, url: 'https://test.example.com/path' });
        expect(result.is_success).toBe(true);
    });

    it('handles EFORMERR error', async () => {
        const err = new Error('format error');
        err.code = 'EFORMERR';
        mockResolver.resolve4.mockRejectedValue(err);

        const result = await checkDns(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns_format');
    });

    it('handles ENOTIMP error', async () => {
        const err = new Error('not implemented');
        err.code = 'ENOTIMP';
        mockResolver.resolve4.mockRejectedValue(err);

        const result = await checkDns(baseMonitor);
        expect(result.is_success).toBe(false);
        expect(result.error_type).toBe('dns_not_implemented');
    });
});
