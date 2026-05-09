<template>
	<article class="room-card" :class="{ 'room-card--expired': isExpired }">
		<header class="room-card__header">
			<span
				class="room-card__status"
				:class="{ 'room-card__status--off': isExpired }"
				:aria-label="isExpired ? t('playbacksync', 'Expired') : t('playbacksync', 'Live')" />
			<h3 class="room-card__title" :class="{ 'room-card__title--mono': !room.name }">
				{{ room.name || shortUuid }}
			</h3>
			<NcActions :forceMenu="true" :inline="0">
				<NcActionButton :closeAfterClick="true" @click="copyShareLink">
					<template #icon>
						<IconCheck v-if="copied" :size="20" />
						<IconLink v-else :size="20" />
					</template>
					{{ t('playbacksync', 'Copy share link') }}
				</NcActionButton>
				<NcActionButton :closeAfterClick="true" @click="emit('delete', room)">
					<template #icon>
						<IconDelete :size="20" />
					</template>
					{{ t('playbacksync', 'Delete room') }}
				</NcActionButton>
			</NcActions>
		</header>

		<a
			class="room-card__url"
			:href="room.targetUrl"
			:title="room.targetUrl"
			target="_blank"
			rel="noopener noreferrer">
			{{ room.targetUrl }}
		</a>

		<div class="room-card__ttl" :aria-live="isExpired ? 'off' : 'polite'">
			<span class="room-card__ttl-label">
				{{ isExpired ? t('playbacksync', 'Expired') : t('playbacksync', 'Expires in') }}
			</span>
			<span v-if="!isExpired" class="room-card__ttl-value">{{ ttl }}</span>
		</div>

		<footer class="room-card__footer">
			<span class="room-card__created">
				{{ t('playbacksync', 'Created {when}', { when: createdAgo }) }}
			</span>
			<NcButton
				:aria-label="t('playbacksync', 'Copy share link')"
				size="small"
				@click="copyShareLink">
				<template #icon>
					<IconCheck v-if="copied" :size="16" />
					<IconCopy v-else :size="16" />
				</template>
				{{ copied ? t('playbacksync', 'Copied') : t('playbacksync', 'Copy link') }}
			</NcButton>
		</footer>
	</article>
</template>

<script setup lang="ts">
import type { Room } from '../types/room.ts'

import { showError, showSuccess } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { getLoggerBuilder } from '@nextcloud/logger'
import { computed, ref } from 'vue'
import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcActions from '@nextcloud/vue/components/NcActions'
import NcButton from '@nextcloud/vue/components/NcButton'
import IconCheck from 'vue-material-design-icons/Check.vue'
import IconCopy from 'vue-material-design-icons/ContentCopy.vue'
import IconDelete from 'vue-material-design-icons/Delete.vue'
import IconLink from 'vue-material-design-icons/LinkVariant.vue'
import { useNow } from '../composables/useNow.ts'

const props = defineProps<{
	room: Room
}>()

const emit = defineEmits<{
	(e: 'delete', room: Room): void
}>()

const logger = getLoggerBuilder().setApp('playbacksync').detectUser().build()

const now = useNow()
const copied = ref(false)

const shortUuid = computed(() => props.room.uuid.replace(/-/g, '').slice(0, 8))

const isExpired = computed(() => props.room.expiresAt <= now.value)

const ttl = computed(() => formatDuration(props.room.expiresAt - now.value))
const createdAgo = computed(() => formatRelativePast(now.value - props.room.createdAt))

/**
 * Render a positive millisecond duration as the largest two units, e.g.
 * "2d 4h", "3h 12m", "5m 09s", "42s". Used by the live TTL countdown.
 *
 * @param ms duration in milliseconds; non-positive values render as "0s"
 * @return short human-readable duration string
 */
function formatDuration(ms: number): string {
	if (ms <= 0) {
		return '0s'
	}
	const totalSeconds = Math.floor(ms / 1000)
	const days = Math.floor(totalSeconds / 86400)
	const hours = Math.floor((totalSeconds % 86400) / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	if (days > 0) {
		return `${days}d ${pad(hours)}h`
	}
	if (hours > 0) {
		return `${hours}h ${pad(minutes)}m`
	}
	if (minutes > 0) {
		return `${minutes}m ${pad(seconds)}s`
	}
	return `${seconds}s`
}

/**
 * Render a positive millisecond duration as a coarse "X unit ago" string
 * for the card's "Created …" caption. Falls back to "just now" under a
 * minute so the line doesn't churn second-by-second for fresh rooms.
 *
 * @param ms how long ago the event happened, in milliseconds
 * @return localized relative-time string, e.g. "5m ago"
 */
function formatRelativePast(ms: number): string {
	if (ms < 60_000) {
		return t('playbacksync', 'just now')
	}
	const minutes = Math.floor(ms / 60_000)
	if (minutes < 60) {
		return t('playbacksync', '{n}m ago', { n: minutes })
	}
	const hours = Math.floor(minutes / 60)
	if (hours < 24) {
		return t('playbacksync', '{n}h ago', { n: hours })
	}
	const days = Math.floor(hours / 24)
	return t('playbacksync', '{n}d ago', { n: days })
}

/**
 * Two-digit zero-pad for display in the duration formatter.
 *
 * @param n a non-negative integer under 100
 * @return the number rendered with at least two digits
 */
function pad(n: number): string {
	return n < 10 ? `0${n}` : `${n}`
}

/**
 * Copy the room's share link to the clipboard and toggle the local
 * `copied` state for a short period so the icon swap and label confirm
 * the action.
 */
async function copyShareLink() {
	try {
		await navigator.clipboard.writeText(props.room.shareLink)
		copied.value = true
		showSuccess(t('playbacksync', 'Share link copied'))
		setTimeout(() => {
			copied.value = false
		}, 1500)
	} catch (error) {
		logger.error('Clipboard write failed', { error })
		showError(t('playbacksync', 'Could not copy to clipboard.'))
	}
}
</script>

<style scoped>
.room-card {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 16px;
	background-color: var(--color-main-background);
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius-large, 12px);
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
	transition: box-shadow 150ms ease, transform 150ms ease, border-color 150ms ease;
}

.room-card:hover {
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
	border-color: var(--color-border-dark, var(--color-border));
	transform: translateY(-1px);
}

.room-card--expired {
	opacity: 0.7;
}

.room-card__header {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

.room-card__status {
	flex: 0 0 auto;
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background-color: var(--color-success, #46ba61);
	box-shadow: 0 0 0 0 var(--color-success, #46ba61);
	animation: room-card-pulse 1.8s ease-out infinite;
}

.room-card__status--off {
	background-color: var(--color-text-maxcontrast, #888);
	box-shadow: none;
	animation: none;
}

@keyframes room-card-pulse {
	0% {
		box-shadow: 0 0 0 0 rgba(70, 186, 97, 0.55);
	}

	70% {
		box-shadow: 0 0 0 8px rgba(70, 186, 97, 0);
	}

	100% {
		box-shadow: 0 0 0 0 rgba(70, 186, 97, 0);
	}
}

@media (prefers-reduced-motion: reduce) {
	.room-card__status {
		animation: none;
	}
}

.room-card__title {
	flex: 1;
	min-width: 0;
	margin: 0;
	font-size: 16px;
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.room-card__title--mono {
	font-family: var(--font-monospace, monospace);
	letter-spacing: 0.05em;
}

.room-card__url {
	display: block;
	padding: 6px 10px;
	background-color: var(--color-background-dark);
	border-radius: var(--border-radius);
	font-family: var(--font-monospace, monospace);
	font-size: 12px;
	color: var(--color-text-maxcontrast);
	text-decoration: none;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.room-card__url:hover,
.room-card__url:focus-visible {
	color: var(--color-primary-element, var(--color-primary));
	text-decoration: underline;
}

.room-card__ttl {
	display: flex;
	align-items: baseline;
	gap: 8px;
}

.room-card__ttl-label {
	font-size: 12px;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--color-text-maxcontrast);
}

.room-card__ttl-value {
	font-family: var(--font-monospace, monospace);
	font-size: 18px;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
	letter-spacing: 0.04em;
	color: var(--color-main-text);
}

.room-card__footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-top: auto;
	padding-top: 4px;
	border-top: 1px solid var(--color-border);
}

.room-card__created {
	font-family: var(--font-monospace, monospace);
	font-size: 11px;
	color: var(--color-text-maxcontrast);
	letter-spacing: 0.03em;
}
</style>
