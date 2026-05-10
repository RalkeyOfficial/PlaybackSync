import { createAppConfig } from '@nextcloud/vite-config'

export default createAppConfig({
	main: 'src/index.ts',
	adminSettings: 'src/adminSettings.ts',
}, {
	// `relativeCSSInjection: true` is required for multi-entry builds —
	// without it `vite-plugin-css-injected-by-js` only injects CSS into one
	// of the entries and the other (here, `playbacksync-main`) ships with
	// no styles at all.
	inlineCSS: { relativeCSSInjection: true },
	extractLicenseInformation: {
		includeSourceMaps: true,
	},
	thirdPartyLicense: undefined,
	emptyOutputDirectory: {
		additionalDirectories: ['css'],
	},
})
