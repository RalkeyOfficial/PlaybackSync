import { createAppConfig } from '@nextcloud/vite-config'

export default createAppConfig({
	main: 'src/index.ts',
}, {
	inlineCSS: false,
	extractLicenseInformation: {
		includeSourceMaps: true,
	},
	thirdPartyLicense: false,
	createEmptyCSSEntryPoints: true,
	emptyOutputDirectory: {
		additionalDirectories: ['css'],
	},
})
