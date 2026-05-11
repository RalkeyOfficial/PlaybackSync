<template>
	<span
		class="status-dot"
		:class="`status-dot--${variant}`"
		:style="{ '--status-dot-size': `${size}px` }"
		:role="ariaLabel ? 'status' : undefined"
		:aria-label="ariaLabel" />
</template>

<script setup lang="ts">
/**
 * A coloured dot, optionally animated, for surfacing a single boolean-ish
 * state in a list, badge, or row header. Pure presentation: takes a
 * variant + size and renders accordingly.
 *
 * Variants:
 *   - success: green, pulsing — a live/active/healthy thing.
 *   - info:    blue, solid    — a working-but-not-active thing (e.g. paused).
 *   - error:   red, solid     — a broken/unreachable thing.
 *   - warning: amber, solid   — set up but not currently working (e.g. daemon down).
 *   - neutral: grey, solid    — an inactive/expired thing.
 *   - pending: grey, blinking — we don't know yet, ask again later.
 *
 * When used inside a labelled wrapper (a badge, list item with adjacent
 * text), leave `aria-label` unset — the wrapper carries the meaning. When
 * used standalone, set `aria-label` so screen readers announce state.
 */

withDefaults(defineProps<{
	variant: 'success' | 'info' | 'error' | 'warning' | 'neutral' | 'pending'
	size?: number
	ariaLabel?: string
}>(), {
	size: 8,
	ariaLabel: undefined,
})
</script>

<style scoped>
.status-dot {
	display: inline-block;
	flex: 0 0 auto;
	width: var(--status-dot-size, 8px);
	height: var(--status-dot-size, 8px);
	border-radius: 50%;
	background-color: var(--color-text-maxcontrast, #888);
	box-shadow: 0 0 0 0 transparent;
}

.status-dot--success {
	background-color: var(--color-element-success, #2ea043);
	animation: status-dot-pulse 1.8s ease-out infinite;
}

.status-dot--info {
	background-color: var(--color-primary-element, #0969da);
}

.status-dot--error {
	background-color: var(--color-element-error, #cf2d2d);
}

.status-dot--warning {
	background-color: var(--color-element-warning, #c98d00);
}

.status-dot--neutral {
	background-color: var(--color-text-maxcontrast, #888);
}

.status-dot--pending {
	background-color: var(--color-text-maxcontrast, #888);
	animation: status-dot-blink 1.4s ease-in-out infinite;
}

@keyframes status-dot-pulse {
	0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-element-success, #2ea043) 55%, transparent); }
	70% { box-shadow: 0 0 0 6px transparent; }
	100% { box-shadow: 0 0 0 0 transparent; }
}

@keyframes status-dot-blink {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
	.status-dot {
		animation: none !important;
	}
}
</style>
