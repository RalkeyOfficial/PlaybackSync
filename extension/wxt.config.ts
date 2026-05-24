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
		// Plugin-based content script: every page must give the runtime a chance
		// to evaluate the adapter registry. Real adapters narrow themselves in
		// canHandlePage(); unsupported pages stay silent (workshop §2 rule 3).
		// Revisit pre-store-submission — an explicit allowlist may be preferred.
		host_permissions: ['<all_urls>'],
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
