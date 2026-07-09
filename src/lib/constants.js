/**
 * Central constants for the m0nitor worker agent.
 * All magic numbers live here with sensible defaults.
 */

// --- Timeouts (ms) ---
export const DEFAULT_MONITOR_TIMEOUT_S = 30;
export const MAX_MONITOR_TIMEOUT_S = 300;
export const MIN_MONITOR_TIMEOUT_S = 1;
export const DNS_RESOLUTION_TIMEOUT_MS = 5000;
export const TLS_HANDSHAKE_TIMEOUT_MS = 10000;
// Backstop watchdog: a check is force-failed if it runs longer than its own
// hard timeout plus this buffer. The buffer lets each check's internal timeout
// fire first under normal conditions; the watchdog only catches true hangs.
export const CHECK_WATCHDOG_BUFFER_MS = 5000;

// --- HTTP ---
export const MAX_RESPONSE_BODY_LENGTH = 10 * 1024 * 1024;  // 10 MB inbound
export const MAX_REQUEST_BODY_LENGTH = 1024 * 1024;          // 1 MB outbound
export const MAX_HEADER_VALUE_LENGTH = 8192;
export const RESPONSE_BODY_PREVIEW_LENGTH = 1024;            // 1 KB preview
export const MAX_REDIRECTS = 5;
export const DEFAULT_HTTP_METHOD = 'GET';
export const DEFAULT_ACCEPTED_STATUS_CODES = [200, 201, 202, 203, 204];
export const DEFAULT_SSL_MIN_DAYS = 7;

// --- DNS ---
export const MAX_DNS_RECORDS = 10;

// --- Ping ---
export const PING_COUNT = 3;

// --- Concurrency ---
export const DEFAULT_CONCURRENCY_LIMIT = 30;

// --- Result Queue ---
export const RESULT_QUEUE_MAX_SIZE = 1000;
export const RESULT_QUEUE_RETRY_INTERVAL_MS = 15000; // 15 seconds
export const RESULT_QUEUE_MAX_RETRIES = 5;
// Max results per batched report request. Larger chunks are split so a single
// request stays well under the API's server-side cap.
export const MAX_REPORT_BATCH_SIZE = 100;

// --- Health ---
export const DEFAULT_HEALTH_PORT = 8080;
export const HEALTH_UNHEALTHY_AFTER_FAILED_POLLS = 3;
