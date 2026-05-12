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

		<NcDialog
			:name="t('playbacksync', 'Delete room?')"
			size="small"
			:open="pendingDeleteRoom !== null"
			:canClose="!deleting"
			@update:open="(v) => { if (!v) { onCancelDelete() } }">
			<p class="rooms-panel__confirm-prompt">
				{{ t('playbacksync', 'Delete room "{name}"?', { name: pendingDeleteLabel }) }}
			</p>
			<p class="rooms-panel__confirm-detail">
				{{ t('playbacksync', 'This will permanently delete the room and disconnect all participants.') }}
			</p>
			<NcCheckboxRadioSwitch
				v-model="dontAskAgainDelete"
				type="checkbox"
				:disabled="deleting">
				{{ t('playbacksync', "Don't ask again") }}
			</NcCheckboxRadioSwitch>
			<template #actions>
				<NcButton :disabled="deleting" @click="onCancelDelete">
					{{ t('playbacksync', 'Cancel') }}
				</NcButton>
				<NcButton
					variant="error"
					:disabled="deleting"
					@click="onConfirmDelete">
					<template #icon>
						<NcLoadingIcon v-if="deleting" :size="20" />
						<IconDelete v-else :size="20" />
					</template>
					{{ t('playbacksync', 'Delete') }}
				</NcButton>
			</template>
		</NcDialog>
	</div>
</template>

<script setup lang="ts">
import type { Room } from '../types/room.ts'

import { translate as t } from '@nextcloud/l10n'
import { computed, onMounted, ref } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import IconCog from 'vue-material-design-icons/Cog.vue'
import IconDelete from 'vue-material-design-icons/Delete.vue'
import IconPlus from 'vue-material-design-icons/Plus.vue'
import IconSync from 'vue-material-design-icons/Sync.vue'
import AutoRefreshRing from './AutoRefreshRing.vue'
import RoomCreatedDialog from './RoomCreatedDialog.vue'
import RoomCreateDialog from './RoomCreateDialog.vue'
import RoomList from './RoomList.vue'
import UserSettingsDialog from './UserSettingsDialog.vue'
import WsStatusBadge from './WsStatusBadge.vue'
import { SKIP_CONFIRM_DELETE_ROOM, useSkipConfirm } from '../composables/useSkipConfirm.ts'
import { sortRooms } from '../composables/useSortRooms.ts'
import { useRoomsStore } from '../stores/rooms.ts'
import { useUserSettingsStore } from '../stores/userSettings.ts'
import { useWsStatusStore } from '../stores/wsStatus.ts'

const store = useRoomsStore()
const wsStatus = useWsStatusStore()
const userSettings = useUserSettingsStore()
const createDialogOpen = ref(false)
const settingsDialogOpen = ref(false)

const skipDeleteConfirm = useSkipConfirm(SKIP_CONFIRM_DELETE_ROOM)
const pendingDeleteRoom = ref<Room | null>(null)
const dontAskAgainDelete = ref(false)
const deleting = ref(false)

const pendingDeleteLabel = computed(() => (
	pendingDeleteRoom.value?.name?.trim() || pendingDeleteRoom.value?.uuid || ''
))

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
 * Entry point from the row's delete action. If the user has previously
 * silenced the confirmation prompt, run the deletion straight through;
 * otherwise stash the room and open the Nextcloud confirmation dialog.
 *
 * @param room the room the user requested to delete
 */
async function onDelete(room: Room) {
	if (skipDeleteConfirm.value) {
		await store.remove(room.uuid)
		return
	}
	dontAskAgainDelete.value = false
	pendingDeleteRoom.value = room
}

/**
 * Close the confirmation dialog without deleting. Guarded so the dialog
 * cannot be dismissed mid-request via the backdrop or escape key.
 */
function onCancelDelete() {
	if (deleting.value) {
		return
	}
	pendingDeleteRoom.value = null
	dontAskAgainDelete.value = false
}

/**
 * Run the confirmed deletion: persist the "don't ask again" choice (if any),
 * delegate to the rooms store, and close the dialog. The store handles its
 * own optimistic update and error toasts.
 */
async function onConfirmDelete() {
	const room = pendingDeleteRoom.value
	if (room === null || deleting.value) {
		return
	}
	if (dontAskAgainDelete.value) {
		skipDeleteConfirm.value = true
	}
	deleting.value = true
	try {
		await store.remove(room.uuid)
	} finally {
		deleting.value = false
		pendingDeleteRoom.value = null
		dontAskAgainDelete.value = false
	}
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

.rooms-panel__confirm-prompt {
	margin: 0 0 8px;
}

.rooms-panel__confirm-detail {
	margin: 0 0 12px;
	color: var(--color-text-maxcontrast);
}
</style>
