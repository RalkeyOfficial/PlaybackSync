import { createAppConfig } from '@nextcloud/vite-config'

export default createAppConfig({
	main: 'src/index.ts',
	adminSettings: 'src/adminSettings.ts',
}, {
	inlineCSS: true,
	extractLicenseInformation: {
		includeSourceMaps: true,
	},
	thirdPartyLicense: undefined,
	emptyOutputDirectory: {
		additionalDirectories: ['css'],
	},
})
