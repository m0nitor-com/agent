import axios from 'axios';
import https from 'https';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from './logger.js';
import { config } from './config.js';

// Get package.json version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

/**
 * API client for communicating with the Laravel backend
 */
class ApiClient {
    constructor(baseUrl, token) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.token = token;
        this.version = pkg.version;

        // Only skip SSL verification if explicitly enabled (INSECURE)
        const httpsAgent = config.SKIP_SSL_VERIFY
            ? new https.Agent({ rejectUnauthorized: false })
            : undefined;

        if (config.SKIP_SSL_VERIFY) {
            logger.warn('[API] SSL certificate verification is DISABLED. This is insecure!');
        }

        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Worker-Version': this.version,
            },
            httpsAgent,
        });
    }

    /**
     * Fetch monitors that need to be checked
     */
    async getChecks() {
        try {
            const response = await this.client.get(`/workers/${this.token}/checks`);
            return response.data;
        } catch (error) {
            logger.error({ err: error }, '[API] Failed to fetch checks');
            throw error;
        }
    }

    /**
     * Report a check result to the backend
     */
    async reportCheck(result) {
        try {
            const response = await this.client.post(`/workers/${this.token}/report`, result);
            return response.data;
        } catch (error) {
            logger.error({ err: error }, '[API] Failed to report check');
            throw error;
        }
    }

    /**
     * Send a heartbeat to update last_seen
     */
    async heartbeat() {
        try {
            await this.client.get(`/workers/${this.token}/checks`);
            logger.debug('[API] Heartbeat sent');
        } catch (error) {
            logger.error({ err: error }, '[API] Heartbeat failed');
        }
    }
}

export default ApiClient;
