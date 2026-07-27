import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
        paths: [
            '*.password',
            '*.secret',
            '*.token',
            '*.authorization',
            '*.credentials',
            '*.config',
            '*.request.headers',
            '*.response.config',
        ],
        censor: '[REDACTED]',
    },
    ...(isDev && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        },
    }),
});
