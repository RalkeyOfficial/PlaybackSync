<template>
	<ul class="room-list">
		<NcListItem
			v-for="room in rooms"
			:key="room.uuid"
			:name="room.name || room.uuid"
			:bold="false"
			:forceDisplayActions="true">
			<template #icon>
				<IconPlay :size="32" />
			</template>
			<template #subname>
				{{ buildSubname(room) }}
			</template>
			<template #actions>
				<NcActionButton
					:closeAfterClick="true"
					@click="emit('delete', room)">
					<template #icon>
						<IconDelete :size="20" />
					</template>
					{{ t('playbacksync', 'Delete room') }}
				</NcActionButton>
			</template>
		</NcListItem>
	</ul>
</template>

<script setup lang="ts">
import type { Room } from '../types/room.ts'

import { translate as t } from '@nextcloud/l10n'
import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcListItem from '@nextcloud/vue/components/NcListItem'
import IconDelete from 'vue-material-design-icons/Delete.vue'
import IconPlay from 'vue-material-design-icons/Play.vue'

defineProps<{
	rooms: Room[]
}>()

const emit = defineEmits<{
	(e: 'delete', room: Room): void
}>()

/**
 * Compose the secondary line shown under each room's name. Uses the user's
 * locale to render `expiresAt` (stored as unix milliseconds).
 *
 * @param room the room whose expiry should be summarized
 * @return a localized "Expires {date}" string
 */
function buildSubname(room: Room): string {
	const expires = new Date(room.expiresAt).toLocaleString()
	return t('playbacksync', 'Expires {date}', { date: expires })
}
</script>

<style scoped>
.room-list {
	list-style: none;
	padding: 0;
	margin: 0;
}
</style>
