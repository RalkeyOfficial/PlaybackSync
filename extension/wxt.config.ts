import { defineConfig } from 'wxt'
import { ADAPTER_MATCHES } from './src/adapters/host-matches'

export default defineConfig({
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
			version: '1.0.0',
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
