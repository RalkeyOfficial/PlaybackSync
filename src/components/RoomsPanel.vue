<template>
	<div class="rooms-panel">
		<header class="rooms-panel__header">
			<WsStatusBadge />
			<div class="rooms-panel__header-spacer" />
			<AutoRefreshRing
				:key="userSettings.autoRefreshIntervalMs"
				:intervalMs="userSettings.autoRefreshIntervalMs"
				storageKey="playbacksync:rooms:auto-refresh"
				:defaultEnabled="true"
				@refresh="store.refresh()" />
			<NcButton
				variant="primary"
				:disabled="wsStatus.isUnavailable"
				:title="createButtonTooltip"
				@click="createDialogOpen = true">
				<template #icon>
					<IconPlus :size="20" />
				</template>
				{{ t('playbacksync', 'Create room') }}
			</NcButton>
		</header>

		<div class="rooms-panel__body">
			<div v-if="store.loading && !store.loaded" class="rooms-panel__loading">
				<NcLoadingIcon :size="48" />
			</div>
			<NcEmptyContent
				v-else-if="store.rooms.length === 0"
				:name="t('playbacksync', 'No rooms yet')"
				:description="t('playbacksync', 'Create a room to start a synchronized watch session.')">
				<template #icon>
					<IconSync :size="64" />
				</template>
				<template #action>
					<NcButton
						variant="primary"
						:disabled="wsStatus.isUnavailable"
						:title="createButtonTooltip"
						@click="createDialogOpen = true">
						<template #icon>
							<IconPlus :size="20" />
						</template>
						{{ t('playbacksync', 'Create room') }}
					</NcButton>
				</template>
			</NcEmptyContent>
			<RoomList v-else :rooms="sortedRooms" @delete="onDelete" />
		</div>

		<footer class="rooms-panel__footer">
			<NcButton
				variant="tertiary"
				:title="t('playbacksync', 'Personal settings')"
				@click="settingsDialogOpen = true">
				<template #icon>
					<IconCog :size="20" />
				</template>
				{{ t('playbacksync', 'Settings') }}
			</NcButton>
		</footer>

		<RoomCreateDialog v-model:open="createDialogOpen" />
		<RoomCreatedDialog :room="store.lastCreated" @dismiss="store.dismissLastCreated()" />
		<UserSettingsDialog v-model:open="settingsDialogOpen" />
	</div>
</template>

<script setup lang="ts">
import type { Room } from '../types/room.ts'

import { translate as t } from '@nextcloud/l10n'
import { computed, onMounted, ref } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import IconCog from 'vue-material-design-icons/Cog.vue'
import IconPlus from 'vue-material-design-icons/Plus.vue'
import IconSync from 'vue-material-design-icons/Sync.vue'
import AutoRefreshRing from './AutoRefreshRing.vue'
import RoomCreatedDialog from './RoomCreatedDialog.vue'
import RoomCreateDialog from './RoomCreateDialog.vue'
import RoomList from './RoomList.vue'
import UserSettingsDialog from './UserSettingsDialog.vue'
import WsStatusBadge from './WsStatusBadge.vue'
import { sortRooms } from '../composables/useSortRooms.ts'
import { useRoomsStore } from '../stores/rooms.ts'
import { useUserSettingsStore } from '../stores/userSettings.ts'
import { useWsStatusStore } from '../stores/wsStatus.ts'

const store = useRoomsStore()
const wsStatus = useWsStatusStore()
const userSettings = useUserSettingsStore()
const createDialogOpen = ref(false)
const settingsDialogOpen = ref(false)

const createButtonTooltip = computed(() => (
	wsStatus.isUnavailable
		? t('playbacksync', 'The WebSocket sync service is not installed. Ask an administrator to set it up.')
		: ''
))

const sortedRooms = computed(() => sortRooms(store.rooms, userSettings.roomsSortOrder))

onMounted(() => {
	store.load()
	wsStatus.load()
	userSettings.load()
})

/**
 * Confirm with the user and delegate deletion to the rooms store. The store
 * removes the row optimistically and surfaces an error toast on failure.
 *
 * @param room the room the user requested to delete
 */
async function onDelete(room: Room) {
	const label = room.name?.trim() || room.uuid
	const message = t('playbacksync', 'Delete room "{name}"?', { name: label })
	if (!window.confirm(message)) {
		return
	}
	await store.remove(room.uuid)
}
</script>

<style scoped>
.rooms-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	padding: 16px;
	gap: 16px;
}

.rooms-panel__header {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
}

.rooms-panel__header-spacer {
	flex: 1;
	min-width: 0;
}

.rooms-panel__body {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
}

.rooms-panel__loading {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 1;
}

.rooms-panel__footer {
	display: flex;
	justify-content: flex-start;
}
</style>
