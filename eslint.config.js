import eslint from '@eslint/js';
import globals from 'globals';

export default [
    eslint.configs.recommended,
    {
        files: ['src/**/*.js', 'bench/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'warn',
        },
    },
];
