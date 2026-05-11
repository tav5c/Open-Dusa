import js from '@eslint/js'
import globals from 'globals'

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.es2024 },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-control-regex': 'off',
            'no-useless-escape': 'warn',
            'require-atomic-updates': 'off',
        },
    },
    {
        files: ['extensions/ai.js'],
        rules: { 'no-unused-vars': 'off' },
    },
]
