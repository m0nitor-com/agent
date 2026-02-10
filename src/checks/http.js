import axios from 'axios';
import https from 'https';
import sslChecker from 'ssl-checker';

/**
 * Perform HTTP/HTTPS check on a monitor
 */
export async function checkHttp(monitor) {
    const startTime = Date.now();
    const result = {
        monitor_id: monitor.id,
        is_success: false,
        response_time_ms: null,
        status_code: null,
        error_message: null,
        error_type: null,
        response_headers: null,
        response_body_preview: null,
        ssl_info: null,
    };

    try {
        // Build request config
        const config = {
            method: monitor.method || 'GET',
            url: monitor.url,
            timeout: (monitor.timeout || 30) * 1000,
            headers: monitor.headers || {},
            maxRedirects: monitor.follow_redirects ? 5 : 0,
            validateStatus: () => true, // Accept any status code
            httpsAgent: new https.Agent({
                rejectUnauthorized: false, // We'll check SSL separately
            }),
        };

        if (monitor.body && ['POST', 'PUT', 'PATCH'].includes(monitor.method)) {
            config.data = monitor.body;
        }

        // Make the request
        const response = await axios(config);

        result.response_time_ms = Date.now() - startTime;
        result.status_code = response.status;
        result.response_headers = response.headers;

        // Get response body preview (first 1KB)
        if (typeof response.data === 'string') {
            result.response_body_preview = response.data.substring(0, 1024);
        } else if (typeof response.data === 'object') {
            result.response_body_preview = JSON.stringify(response.data).substring(0, 1024);
        }

        // Check success criteria
        const criteria = monitor.success_criteria || {};
        const acceptedCodes = criteria.status_codes || [200, 201, 202, 203, 204];
        const maxResponseTime = criteria.max_response_time || 30000;

        // Check status code
        if (!acceptedCodes.includes(response.status)) {
            result.is_success = false;
            result.error_type = 'status_code';
            result.error_message = `Expected status ${acceptedCodes.join('/')}, got ${response.status}`;
            return result;
        }

        // Check response time
        if (result.response_time_ms > maxResponseTime) {
            result.is_success = false;
            result.error_type = 'response_time';
            result.error_message = `Response time ${result.response_time_ms}ms exceeds limit ${maxResponseTime}ms`;
            return result;
        }

        // Check keywords if specified
        if (criteria.keywords && criteria.keywords.length > 0) {
            const bodyText = result.response_body_preview || '';
            for (const keyword of criteria.keywords) {
                if (!bodyText.includes(keyword)) {
                    result.is_success = false;
                    result.error_type = 'keyword';
                    result.error_message = `Keyword "${keyword}" not found in response`;
                    return result;
                }
            }
        }

        // SSL check for HTTPS monitors
        if (monitor.type === 'https' && criteria.ssl_check !== false) {
            try {
                const urlObj = new URL(monitor.url);
                const sslResult = await sslChecker(urlObj.hostname);

                result.ssl_info = {
                    valid: sslResult.valid,
                    days_remaining: sslResult.daysRemaining,
                    issuer: sslResult.issuer,
                    valid_from: sslResult.validFrom,
                    valid_to: sslResult.validTo,
                };

                const minDays = criteria.ssl_min_days || 7;
                if (!sslResult.valid) {
                    result.is_success = false;
                    result.error_type = 'ssl';
                    result.error_message = 'SSL certificate is invalid';
                    return result;
                }

                if (sslResult.daysRemaining < minDays) {
                    result.is_success = false;
                    result.error_type = 'ssl';
                    result.error_message = `SSL certificate expires in ${sslResult.daysRemaining} days (min: ${minDays})`;
                    return result;
                }
            } catch (sslError) {
                console.warn('[HTTP] SSL check failed:', sslError.message);
                result.ssl_info = { error: sslError.message };
            }
        }

        result.is_success = true;

    } catch (error) {
        result.response_time_ms = Date.now() - startTime;

        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            result.error_type = 'timeout';
            result.error_message = `Connection timed out after ${monitor.timeout || 30}s`;
        } else if (error.code === 'ENOTFOUND') {
            result.error_type = 'dns';
            result.error_message = `DNS resolution failed for ${monitor.url}`;
        } else if (error.code === 'ECONNREFUSED') {
            result.error_type = 'connection';
            result.error_message = 'Connection refused';
        } else {
            result.error_type = 'unknown';
            result.error_message = error.message || 'Unknown error';
        }
    }

    return result;
}

export default checkHttp;
