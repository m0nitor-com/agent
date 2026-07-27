import axios from 'axios';
import https from 'https';
import http from 'http';
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
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason || new Error('Request aborted'));
            return;
        }
        const done = () => {
            signal?.removeEventListener('abort', aborted);
            resolve();
        };
        const aborted = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', aborted);
            reject(signal.reason || new Error('Request aborted'));
        };
        const timer = setTimeout(done, ms);
        timer.unref?.();
        signal?.addEventListener('abort', aborted, { once: true });
    });
}

/**
 * API client for communicating with the m0nitor API
 */
class ApiClient {
    constructor(baseUrl, token, capabilities = []) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.token = token;
        this.version = pkg.version;
        this.maxRetries = 3;
        this.baseDelay = 1000; // 1 second

        this.httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 2,
            maxFreeSockets: 1,
            timeout: 10_000,
            scheduling: 'lifo',
        });
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 2,
            maxFreeSockets: 1,
            timeout: 10_000,
            scheduling: 'lifo',
            rejectUnauthorized: !config.SKIP_SSL_VERIFY,
        });

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
                'X-Agent-Contract-Version': '2',
                'X-Agent-Capabilities': capabilities.slice(0, 32).join(','),
                'Authorization': `Bearer ${this.token}`,
            },
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
            maxContentLength: 2 * 1024 * 1024,
            maxBodyLength: 2 * 1024 * 1024,
        });
    }

    /**
     * Execute a request with exponential backoff retry
     */
    async withRetry(fn, context = 'request', options = {}) {
        let lastError;
        const maxRetries = Number.isInteger(options.retries) ? options.retries : this.maxRetries;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (options.signal?.aborted) {
                    throw options.signal.reason || new Error('Request aborted');
                }
                return await fn();
            } catch (error) {
                lastError = error;
                if (options.signal?.aborted) throw error;

                // Don't retry on auth errors or validation errors
                const status = error.response?.status;
                if (status === 401 || status === 403 || status === 422) {
                    throw error;
                }

                if (attempt < maxRetries) {
                    const delay = this.baseDelay * Math.pow(2, attempt);
                    const jitter = delay * (0.5 + Math.random() * 0.5);
                    logger.warn({
                        context,
                        attempt: attempt + 1,
                        attempts: maxRetries + 1,
                        retry_in_ms: Math.round(jitter),
                        status: error.response?.status,
                        code: error.code,
                    }, '[API] Request failed, retrying');
                    await sleep(jitter, options.signal);
                }
            }
        }

        logger.error({
            context,
            attempts: maxRetries + 1,
            status: lastError?.response?.status,
            code: lastError?.code,
        }, '[API] Request failed after retry limit');
        throw lastError;
    }

    /**
     * Fetch monitors that need to be checked
     */
    async getChecks(options = {}) {
        return this.withRetry(async () => {
            const health = options.health
                ? Buffer.from(JSON.stringify(options.health)).toString('base64url')
                : null;
            const response = Object.keys(options).length > 0
                ? await this.client.get('/workers/checks', {
                    signal: options.signal,
                    headers: health ? { 'X-Agent-Health': health.slice(0, 6000) } : undefined,
                })
                : await this.client.get('/workers/checks');
            return response.data;
        }, 'getChecks', options);
    }

    /**
     * Report a check result to the backend
     */
    async reportCheck(result, options = {}) {
        return this.withRetry(async () => {
            const response = Object.keys(options).length > 0
                ? await this.client.post('/workers/report', result, { signal: options.signal })
                : await this.client.post('/workers/report', result);
            return response.data;
        }, 'reportCheck', options);
    }

    /**
     * Report a batch of check results to the backend in a single request.
     */
    async reportBatch(results, options = {}) {
        return this.withRetry(async () => {
            const response = Object.keys(options).length > 0
                ? await this.client.post('/workers/report-batch', { reports: results }, { signal: options.signal })
                : await this.client.post('/workers/report-batch', { reports: results });
            return response.data;
        }, 'reportBatch', options);
    }

    close() {
        this.httpAgent.destroy();
        this.httpsAgent.destroy();
    }
}

export default ApiClient;
