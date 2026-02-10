import { cleanEnv, str, num, url, bool } from 'envalid';
import 'dotenv/config';

export const config = cleanEnv(process.env, {
    API_URL: url({ desc: 'The URL of the m0nitor API' }),
    PROBE_TOKEN: str({ desc: 'The authentication token for this worker' }),
    LOG_LEVEL: str({ default: 'info', choices: ['debug', 'info', 'warn', 'error'] }),
    POLL_INTERVAL: num({ default: 5000, desc: 'Polling interval in milliseconds' }),
    AUTO_UPDATE: bool({ default: true, desc: 'Enable auto-updates (Docker uses image tags instead)' }),
    SKIP_SSL_VERIFY: bool({ default: false, desc: 'Skip SSL certificate verification (INSECURE - only for development)' }),
});
