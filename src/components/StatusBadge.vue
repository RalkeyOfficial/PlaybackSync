<template>
	<span
		class="status-badge"
		:class="`status-badge--${variant}`"
		:title="tooltip"
		role="status"
		:aria-label="label">
		<StatusDot :variant="variant" />
		<span class="status-badge__label">{{ label }}</span>
	</span>
</template>

<script setup lang="ts">
import StatusDot from './StatusDot.vue'

/**
 * A pill-shaped status indicator: a coloured dot followed by a label.
 * Pure presentation; consumers map their domain state to a variant +
 * label + tooltip.
 */

withDefaults(defineProps<{
	variant: 'success' | 'error' | 'neutral' | 'pending'
	label: string
	tooltip?: string
}>(), {
	tooltip: undefined,
})
</script>

<style scoped>
.status-badge {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 4px 12px 4px 10px;
	border-radius: 999px;
	border: 1px solid var(--color-border, #d8d8d8);
	background-color: var(--color-background-hover, #f5f5f5);
	font-size: 12px;
	font-weight: 500;
	line-height: 1.4;
	color: var(--color-main-text, #222);
	user-select: none;
	transition: background-color 120ms ease, border-color 120ms ease;
}

.status-badge__label {
	white-space: nowrap;
}

.status-badge--success {
	border-color: color-mix(in srgb, var(--color-success, #46ba61) 35%, transparent);
	background-color: color-mix(in srgb, var(--color-success, #46ba61) 10%, var(--color-main-background, #fff));
}

.status-badge--error {
	border-color: color-mix(in srgb, var(--color-error, #e9322d) 35%, transparent);
	background-color: color-mix(in srgb, var(--color-error, #e9322d) 10%, var(--color-main-background, #fff));
}
</style>
