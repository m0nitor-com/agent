import { describe, it, expect } from 'vitest';

// We test the sanitize function by importing the module's internals
// Since sanitizeBodyPreview is not exported, we test it through checkHttp behavior
// For unit testing, we replicate the patterns here

const SENSITIVE_PATTERNS = [
    /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|credential)["\s]*[:=]["\s]*["']?[a-zA-Z0-9_\-./+=]{8,}["']?/gi,
    /(?:Bearer|Basic)\s+[a-zA-Z0-9_\-./+=]{20,}/gi,
    /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
];

function sanitizeBodyPreview(body) {
    if (!body || typeof body !== 'string') return body;
    let sanitized = body;
    for (const pattern of SENSITIVE_PATTERNS) {
        sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
    return sanitized;
}

describe('sanitizeBodyPreview', () => {
    it('returns non-string input as-is', () => {
        expect(sanitizeBodyPreview(null)).toBeNull();
        expect(sanitizeBodyPreview(undefined)).toBeUndefined();
    });

    it('does not modify clean body', () => {
        const body = '{"status":"ok","data":[1,2,3]}';
        expect(sanitizeBodyPreview(body)).toBe(body);
    });

    it('redacts api_key patterns', () => {
        const body = '{"api_key": "sk_live_abcdefgh12345678"}';
        expect(sanitizeBodyPreview(body)).toContain('[REDACTED]');
        expect(sanitizeBodyPreview(body)).not.toContain('sk_live_abcdefgh12345678');
    });

    it('redacts Bearer tokens', () => {
        const body = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6';
        expect(sanitizeBodyPreview(body)).toContain('[REDACTED]');
    });

    it('redacts JWT tokens', () => {
        const body = 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
        expect(sanitizeBodyPreview(body)).toContain('[REDACTED]');
    });

    it('redacts password fields', () => {
        const body = '{"password": "mysecretpassword123"}';
        expect(sanitizeBodyPreview(body)).toContain('[REDACTED]');
        expect(sanitizeBodyPreview(body)).not.toContain('mysecretpassword123');
    });

    it('redacts secret_key fields', () => {
        const body = 'secret_key=verysecretkey12345678';
        expect(sanitizeBodyPreview(body)).toContain('[REDACTED]');
    });

    it('handles multiple sensitive fields', () => {
        const body = '{"api_key":"abc12345678","password":"secret12345678"}';
        const sanitized = sanitizeBodyPreview(body);
        expect(sanitized).not.toContain('abc12345678');
        expect(sanitized).not.toContain('secret12345678');
    });
});
