import { createPinia } from 'pinia'
import { createApp } from 'vue'
import AdminSettings from './views/AdminSettings.vue'

createApp(AdminSettings)
	.use(createPinia())
	.mount('#playbacksync-admin-settings')
