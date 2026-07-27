/**
 * Central constants for the m0nitor worker agent.
 * All magic numbers live here with sensible defaults.
 * Concurrency defaults target the 1c/1GB SKU; runtime config
 * replaces them from cgroup/host detection when available.
 */

// --- Timeouts (ms) ---
export const DEFAULT_MONITOR_TIMEOUT_S = 30;
export const MAX_MONITOR_TIMEOUT_S = 300;
export const MIN_MONITOR_TIMEOUT_S = 1;
export const DNS_RESOLUTION_TIMEOUT_MS = 5000;
export const TLS_HANDSHAKE_TIMEOUT_MS = 10000;
export const CHECK_WATCHDOG_BUFFER_MS = 1000;

// --- HTTP ---
export const MAX_RESPONSE_BODY_LENGTH = 2 * 1024 * 1024;   // 2 MB inbound
export const MAX_REQUEST_BODY_LENGTH = 1024 * 1024;          // 1 MB outbound
export const MAX_HEADER_VALUE_LENGTH = 8192;
// The ceiling for response headers is not set here: Node applies it inside its
// parser, so it has to come from --max-http-header-size on the command line
// (see package.json and the Dockerfile). Its default of 16 KB is too low for
// the real web - a single Link header carrying preload hints can be ~29 KB -
// and going over it aborts the whole response with HPE_HEADER_OVERFLOW.
// Read the value in force at runtime from http.maxHeaderSize.
export const RESPONSE_BODY_PREVIEW_LENGTH = 1024;            // 1 KB preview
export const MAX_REDIRECTS = 5;
export const DEFAULT_HTTP_METHOD = 'GET';
export const DEFAULT_ACCEPTED_STATUS_CODES = [200, 201, 202, 203, 204];
export const DEFAULT_SSL_MIN_DAYS = 7;
export const DEFAULT_HTTP_MAX_SOCKETS = 6;
export const DEFAULT_HTTP_MAX_FREE_SOCKETS = 2;

// --- DNS ---
export const MAX_DNS_RECORDS = 10;
export const MAX_ERROR_MESSAGE_LENGTH = 512;

// --- Ping ---
export const PING_COUNT = 3;

// --- Concurrency (1c/1GB SKU defaults) ---
export const DEFAULT_CONCURRENCY_LIMIT = 16;
export const DEFAULT_NETWORK_CONCURRENCY = 13;
export const DEFAULT_DATABASE_CONCURRENCY = 2;
export const DEFAULT_DIAGNOSTIC_CONCURRENCY = 1;
export const MAX_CONCURRENCY_LIMIT = 64;

// --- Result Queue (1c/1GB SKU defaults) ---
export const RESULT_QUEUE_MAX_SIZE = 500;
export const RESULT_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const RESULT_QUEUE_RETRY_INTERVAL_MS = 15000; // 15 seconds
export const RESULT_QUEUE_RETRY_MAX_INTERVAL_MS = 5 * 60 * 1000;
export const RESULT_QUEUE_MAX_RETRIES = 5;
// Max results per batched report request. Larger chunks are split so a single
// request stays well under the API's server-side cap.
export const MAX_REPORT_BATCH_SIZE = 50;
export const MAX_REPORT_BATCH_BYTES = 512 * 1024;

// --- Report coalescing ---
export const REPORT_COALESCE_IDLE_MS = 30;
export const REPORT_MAX_IN_FLIGHT = 2;
export const REPORT_HOT_PATH_RETRIES = 0;

// --- Resource governor ---
export const GOVERNOR_TICK_INTERVAL_MS = 1000;
export const GOVERNOR_EVENT_LOOP_P99_SOFT_MS = 50;
export const GOVERNOR_EVENT_LOOP_P99_HARD_MS = 150;
export const GOVERNOR_RESTORE_STABLE_TICKS = 5;
export const GOVERNOR_SOFT_RSS_BYTES = 350 * 1024 * 1024;
export const GOVERNOR_HARD_RSS_BYTES = 550 * 1024 * 1024;
export const SETTLE_LOG_SAMPLE_RATE = 50;

// --- Health ---
export const DEFAULT_HEALTH_PORT = 8080;
export const HEALTH_UNHEALTHY_AFTER_FAILED_POLLS = 3;
export const HEALTH_RESPONSE_MAX_BYTES = 16 * 1024;
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 5000;
export const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
