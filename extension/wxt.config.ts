import { defineConfig } from 'wxt'

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
		// Placeholder match list — replace with the streaming sites you actually
		// want to sync. The content script only runs on URLs that match these.
		host_permissions: [
			'https://www.miruro.tv/*',
			'https://www.miruro.to/*',
		],
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
