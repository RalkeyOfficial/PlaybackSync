<template>
	<button
		type="button"
		class="auto-refresh-ring"
		:class="{ 'auto-refresh-ring--paused': !autoRefresh.enabled.value }"
		:aria-pressed="autoRefresh.enabled.value"
		:aria-label="ariaLabel"
		:title="tooltip"
		@click="autoRefresh.toggle()">
		<svg
			class="auto-refresh-ring__svg"
			viewBox="0 0 36 36"
			aria-hidden="true">
			<circle
				class="auto-refresh-ring__track"
				cx="18"
				cy="18"
				:r="RING_RADIUS"
				fill="none" />
			<circle
				class="auto-refresh-ring__progress"
				cx="18"
				cy="18"
				:r="RING_RADIUS"
				fill="none"
				:stroke-dasharray="RING_CIRCUMFERENCE"
				:stroke-dashoffset="RING_CIRCUMFERENCE * (1 - autoRefresh.progress.value)"
				transform="rotate(-90 18 18)" />
		</svg>
		<IconRefresh :size="iconSize" class="auto-refresh-ring__icon" />
	</button>
</template>

<script setup lang="ts">
import { translate as t } from '@nextcloud/l10n'
import { computed } from 'vue'
import IconRefresh from 'vue-material-design-icons/Refresh.vue'
import { useAutoRefresh } from '../composables/useAutoRefresh.ts'

const props = withDefaults(defineProps<{
	intervalMs: number
	storageKey?: string
	defaultEnabled?: boolean
	iconSize?: number
}>(), {
	storageKey: undefined,
	defaultEnabled: false,
	iconSize: 18,
})

const emit = defineEmits<{
	refresh: []
}>()

const RING_RADIUS = 15
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const autoRefresh = useAutoRefresh(() => emit('refresh'), {
	intervalMs: props.intervalMs,
	storageKey: props.storageKey,
	defaultEnabled: props.defaultEnabled,
})

const tooltip = computed(() => (
	autoRefresh.enabled.value
		? t('playbacksync', 'Auto-refresh on — click to pause')
		: t('playbacksync', 'Auto-refresh paused — click to resume')
))

const ariaLabel = computed(() => (
	autoRefresh.enabled.value
		? t('playbacksync', 'Pause auto-refresh')
		: t('playbacksync', 'Resume auto-refresh')
))
</script>

<style scoped>
.auto-refresh-ring {
	position: relative;
	width: 36px;
	height: 36px;
	padding: 0;
	border: none;
	background: transparent;
	border-radius: 50%;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: var(--color-primary-element, var(--color-primary, #0082c9));
	transition: background-color 120ms ease, color 120ms ease;
}

.auto-refresh-ring:hover {
	background-color: var(--color-background-hover, rgba(127, 127, 127, 0.12));
}

.auto-refresh-ring:focus-visible {
	outline: 2px solid var(--color-primary-element, var(--color-primary, #0082c9));
	outline-offset: 2px;
}

.auto-refresh-ring--paused {
	color: var(--color-text-maxcontrast, #888);
}

.auto-refresh-ring__svg {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	overflow: visible;
}

.auto-refresh-ring__track {
	stroke: var(--color-border, #d8d8d8);
	stroke-width: 2;
}

.auto-refresh-ring__progress {
	stroke: currentColor;
	stroke-width: 2.5;
	stroke-linecap: round;
	transition: stroke-dashoffset 80ms linear, stroke 200ms ease;
}

.auto-refresh-ring__icon {
	position: relative;
	z-index: 1;
	color: currentColor;
}
</style>
