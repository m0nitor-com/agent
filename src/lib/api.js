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
 * Sleep for a given number of milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * API client for communicating with the Laravel backend
 */
class ApiClient {
    constructor(baseUrl, token) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.token = token;
        this.version = pkg.version;
        this.maxRetries = 3;
        this.baseDelay = 1000; // 1 second

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
     * Execute a request with exponential backoff retry
     */
    async withRetry(fn, context = 'request') {
        let lastError;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;

                // Don't retry on auth errors or validation errors
                const status = error.response?.status;
                if (status === 401 || status === 403 || status === 422) {
                    throw error;
                }

                if (attempt < this.maxRetries) {
                    const delay = this.baseDelay * Math.pow(2, attempt);
                    const jitter = delay * (0.5 + Math.random() * 0.5);
                    logger.warn(`[API] ${context} failed (attempt ${attempt + 1}/${this.maxRetries + 1}), retrying in ${Math.round(jitter)}ms...`);
                    await sleep(jitter);
                }
            }
        }

        logger.error({ err: lastError }, `[API] ${context} failed after ${this.maxRetries + 1} attempts`);
        throw lastError;
    }

    /**
     * Fetch monitors that need to be checked
     */
    async getChecks() {
        return this.withRetry(async () => {
            const response = await this.client.get(`/workers/${this.token}/checks`);
            return response.data;
        }, 'getChecks');
    }

    /**
     * Report a check result to the backend
     */
    async reportCheck(result) {
        return this.withRetry(async () => {
            const response = await this.client.post(`/workers/${this.token}/report`, result);
            return response.data;
        }, 'reportCheck');
    }
}

export default ApiClient;
