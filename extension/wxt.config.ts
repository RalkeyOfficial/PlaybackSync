import { defineConfig } from 'wxt'
import { ADAPTER_MATCHES } from './src/adapters/host-matches'

export default defineConfig({
	// Manifest version is left to WXT's per-browser default: Chrome → MV3
	// (MV2 is sunset there), Firefox → MV2. Firefox MV3 *dev mode* is
	// unsupported upstream (WXT refuses it; Mozilla bug 1864284), so forcing
	// MV3 here would break `wxt -b firefox`. MV2 on Firefox is fully supported
	// and functionally equivalent for this extension — the only surface that
	// differs is the toolbar-action API (`action` vs `browserAction`), which
	// `src/background/icon.ts` resolves across both. Revisit if/when Firefox
	// MV3 dev is supported.
	imports: {
		eslintrc: {
			enabled: 9,
		},
	},
	manifest: ({ mode }) => {
		const isRelease = mode === 'production'
		const nameSuffix = isRelease ? '' : ' (DEV)'
		return {
			name: `PlaybackSync${nameSuffix}`,
			description: 'Frame-tight video sync across browsers — every play, pause, and seek mirrored in milliseconds over a self-hosted WebSocket relay.',
			version: '1.1.0',
			permissions: [
				'storage',
				'alarms',
				'tabs',
			],
			host_permissions: [...ADAPTER_MATCHES],
			action: {
				default_title: `PlaybackSync${nameSuffix}`,
			},
			browser_specific_settings: {
				gecko: {
					id: 'playbacksync@ralkey',
					strict_min_version: '109.0',
				},
			},
		}
	},
})
