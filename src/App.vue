<template>
	<NcContent appName="playbacksync">
		<NcAppNavigation>
			<template #list>
				<NcAppNavigationItem :name="t('playbacksync', 'Rooms')"
					:to="{ name: 'rooms' }">
					<template #icon>
						<IconSync :size="20" />
					</template>
				</NcAppNavigationItem>
			</template>
		</NcAppNavigation>
		<NcAppContent>
			<div class="playbacksync-content">
				<NcEmptyContent :name="t('playbacksync', 'PlaybackSync')"
					:description="t('playbacksync', 'Create or join a room to sync video playback with others.')">
					<template #icon>
						<IconSync :size="64" />
					</template>
				</NcEmptyContent>
			</div>
		</NcAppContent>
	</NcContent>
</template>

<script setup lang="ts">
import { translate as t } from '@nextcloud/l10n'
import NcAppContent from '@nextcloud/vue/components/NcAppContent'
import NcAppNavigation from '@nextcloud/vue/components/NcAppNavigation'
import NcAppNavigationItem from '@nextcloud/vue/components/NcAppNavigationItem'
import NcContent from '@nextcloud/vue/components/NcContent'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import IconSync from 'vue-material-design-icons/Sync.vue'
</script>

<style scoped>
.playbacksync-content {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 100%;
}
</style>
