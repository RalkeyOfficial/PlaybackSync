<template>
	<div class="room-grid">
		<RoomCard
			v-for="room in rooms"
			:key="room.uuid"
			:room="room"
			@delete="emit('delete', $event)" />
	</div>
</template>

<script setup lang="ts">
import type { Room } from '../types/room.ts'

import RoomCard from './RoomCard.vue'

defineProps<{
	rooms: Room[]
}>()

const emit = defineEmits<{
	(e: 'delete', room: Room): void
}>()
</script>

<style scoped>
.room-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
	padding: 0;
	margin: 0;
}
</style>
