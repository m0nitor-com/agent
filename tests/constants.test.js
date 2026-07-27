import { describe, it, expect } from 'vitest';
import * as constants from '../src/lib/constants.js';

describe('constants', () => {
    it('exports all required timeout constants', () => {
        expect(constants.DEFAULT_MONITOR_TIMEOUT_S).toBe(30);
        expect(constants.MAX_MONITOR_TIMEOUT_S).toBe(300);
        expect(constants.MIN_MONITOR_TIMEOUT_S).toBe(1);
        expect(constants.DNS_RESOLUTION_TIMEOUT_MS).toBe(5000);
        expect(constants.TLS_HANDSHAKE_TIMEOUT_MS).toBe(10000);
        expect(constants.CHECK_WATCHDOG_BUFFER_MS).toBe(1000);
    });

    it('exports HTTP constants', () => {
        expect(constants.MAX_RESPONSE_BODY_LENGTH).toBe(2 * 1024 * 1024);
        expect(constants.MAX_REQUEST_BODY_LENGTH).toBe(1024 * 1024);
        expect(constants.MAX_HEADER_VALUE_LENGTH).toBe(8192);
        expect(constants.RESPONSE_BODY_PREVIEW_LENGTH).toBe(1024);
        expect(constants.MAX_REDIRECTS).toBe(5);
        expect(constants.DEFAULT_HTTP_METHOD).toBe('GET');
        expect(constants.DEFAULT_ACCEPTED_STATUS_CODES).toEqual([200, 201, 202, 203, 204]);
        expect(constants.DEFAULT_SSL_MIN_DAYS).toBe(7);
    });

    it('exports DNS constants', () => {
        expect(constants.MAX_DNS_RECORDS).toBe(10);
    });

    it('exports concurrency constants', () => {
        expect(constants.DEFAULT_CONCURRENCY_LIMIT).toBe(16);
        expect(constants.DEFAULT_NETWORK_CONCURRENCY).toBe(13);
        expect(constants.DEFAULT_DATABASE_CONCURRENCY).toBe(2);
        expect(constants.DEFAULT_DIAGNOSTIC_CONCURRENCY).toBe(1);
    });

    it('exports result queue constants', () => {
        expect(constants.RESULT_QUEUE_MAX_SIZE).toBe(500);
        expect(constants.RESULT_QUEUE_MAX_BYTES).toBe(4 * 1024 * 1024);
        expect(constants.MAX_REPORT_BATCH_SIZE).toBe(50);
        expect(constants.MAX_REPORT_BATCH_BYTES).toBe(512 * 1024);
        expect(constants.RESULT_QUEUE_RETRY_INTERVAL_MS).toBe(15000);
        expect(constants.RESULT_QUEUE_MAX_RETRIES).toBe(5);
    });

    it('exports HTTP pool and governor defaults', () => {
        expect(constants.DEFAULT_HTTP_MAX_SOCKETS).toBe(6);
        expect(constants.DEFAULT_HTTP_MAX_FREE_SOCKETS).toBe(2);
        expect(constants.REPORT_MAX_IN_FLIGHT).toBe(2);
        expect(constants.GOVERNOR_SOFT_RSS_BYTES).toBe(350 * 1024 * 1024);
        expect(constants.GOVERNOR_HARD_RSS_BYTES).toBe(550 * 1024 * 1024);
        expect(constants.MAX_ERROR_MESSAGE_LENGTH).toBe(512);
    });

    it('exports health constants', () => {
        expect(constants.DEFAULT_HEALTH_PORT).toBe(8080);
        expect(constants.HEALTH_UNHEALTHY_AFTER_FAILED_POLLS).toBe(3);
    });
});
