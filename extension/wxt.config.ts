import { defineConfig } from 'wxt'
import { ADAPTER_MATCHES } from './src/adapters/host-matches'

export default defineConfig({
	imports: {
		eslintrc: {
			enabled: 9,
		},
	},
	manifest: {
		name: 'PlaybackSync',
		description: 'Synchronize video playback across a Nextcloud-hosted room.',
		version: '0.1.0',
		permissions: [
			'storage',
			'alarms',
			'tabs',
		],
		host_permissions: [...ADAPTER_MATCHES],
		action: {
			default_title: 'PlaybackSync',
		},
		browser_specific_settings: {
			gecko: {
				id: 'playbacksync@ralkey',
				strict_min_version: '109.0',
			},
		},
	},
})
