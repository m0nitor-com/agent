import { cleanEnv, str, num, url, bool } from 'envalid';
import 'dotenv/config';
import { DEFAULT_CONCURRENCY_LIMIT, DEFAULT_HEALTH_PORT } from './constants.js';

export const config = cleanEnv(process.env, {
    API_URL: url({ desc: 'The URL of the m0nitor API' }),
    PROBE_TOKEN: str({ desc: 'The authentication token for this agent' }),
    LOG_LEVEL: str({ default: 'info', choices: ['debug', 'info', 'warn', 'error'] }),
    POLL_INTERVAL: num({ default: 5000, desc: 'Polling interval in milliseconds' }),
    POLL_MAX_INTERVAL: num({ default: 300_000, desc: 'Max poll interval (ms) under exponential backoff during consecutive failures' }),
    SKIP_SSL_VERIFY: bool({ default: false, desc: 'Skip SSL certificate verification (INSECURE - only for development)' }),
    HEALTH_PORT: num({ default: DEFAULT_HEALTH_PORT, desc: 'Port for the health check HTTP server' }),
    CONCURRENCY_LIMIT: num({ default: DEFAULT_CONCURRENCY_LIMIT, desc: 'Max concurrent checks per batch' }),
});
