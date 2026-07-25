import { recommended } from '@nextcloud/eslint-config'

export default [
	// Throwaway unpacked debug extension — not part of any build, kept out of
	// the repo's lint rules (it targets plain browser JS, not the Nextcloud style).
	{ ignores: ['debug-ext/**'] },
	...recommended,
]
