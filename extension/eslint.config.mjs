import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import autoImports from './.wxt/eslint-auto-imports.mjs';

export default [
	{
		ignores: ['.output/**', '.wxt/**', 'node_modules/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	autoImports,
];
