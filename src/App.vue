<template>
	<NcContent appName="playbacksync">
		<NcAppContent>
			<RoomsPanel />
		</NcAppContent>
	</NcContent>
</template>

<script setup lang="ts">
import NcAppContent from '@nextcloud/vue/components/NcAppContent'
import NcContent from '@nextcloud/vue/components/NcContent'
import RoomsPanel from './components/RoomsPanel.vue'
</script>
