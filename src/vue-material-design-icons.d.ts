declare module 'vue-material-design-icons/*.vue' {
	import type { DefineComponent } from 'vue'

	const IconVue: DefineComponent<{
		/** @default 24 */
		size?: number
		/** @default 'currentColor' */
		fillColor?: string
		title?: string
	}>

	export default IconVue
}
