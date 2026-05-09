<template>
	<article
		class="room-card room-card--clickable"
		:class="{ 'room-card--expired': isExpired }"
		role="button"
		tabindex="0"
		:aria-label="t('playbacksync', 'Open details for room {name}', { name: title })"
		@click="openDetail"
		@keydown.enter.prevent="openDetail"
		@keydown.space.prevent="openDetail">
		<header class="room-card__header">
			<StatusDot
				:variant="isExpired ? 'neutral' : 'success'"
				:size="10"
				:ariaLabel="isExpired ? t('playbacksync', 'Expired') : t('playbacksync', 'Live')" />
			<h3 class="room-card__title" :class="{ 'room-card__title--mono': !room.name }">
				{{ title }}
			</h3>
			<div class="room-card__actions" @click.stop>
				<NcActions :forceMenu="true" :inline="0">
					<NcActionButton :closeAfterClick="true" @click="copyShareLink">
						<template #icon>
							<IconCheck v-if="copied" :size="20" />
							<IconLink v-else :size="20" />
						</template>
						{{ t('playbacksync', 'Copy share link') }}
					</NcActionButton>
					<NcActionButton :closeAfterClick="true" @click="openDetail">
						<template #icon>
							<IconOpenInNew :size="20" />
						</template>
						{{ t('playbacksync', 'View details') }}
					</NcActionButton>
					<NcActionButton :closeAfterClick="true" @click="emit('delete', room)">
						<template #icon>
							<IconDelete :size="20" />
						</template>
						{{ t('playbacksync', 'Delete room') }}
					</NcActionButton>
				</NcActions>
			</div>
		</header>

		<a
			class="room-card__url"
			:href="room.targetUrl"
			:title="room.targetUrl"
			target="_blank"
			rel="noopener noreferrer"
			@click.stop>
			{{ room.targetUrl }}
		</a>

		<div class="room-card__ttl" :aria-live="isExpired ? 'off' : 'polite'">
			<span class="room-card__ttl-label">
				{{ isExpired ? t('playbacksync', 'Expired') : t('playbacksync', 'Expires in') }}
			</span>
			<span v-if="!isExpired" class="room-card__ttl-value">{{ ttl }}</span>
		</div>

		<footer class="room-card__footer">
			<span class="room-card__meta" :title="t('playbacksync', 'Created')">
				<IconClock :size="14" />
				<span>{{ createdAgo }}</span>
			</span>
			<span
				class="room-card__meta room-card__meta--viewers"
				:class="{ 'room-card__meta--active': live && live.connectedCount > 0 }"
				:title="t('playbacksync', 'Connected viewers')">
				<IconAccountMultiple :size="14" />
				<span>{{ viewersDisplay }}</span>
			</span>
		</footer>

		<RoomDetailDialog
			v-model:open="detailOpen"
			:room="room"
			@delete="onDeleteFromDialog" />
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
import IconAccountMultiple from 'vue-material-design-icons/AccountMultiple.vue'
import IconCheck from 'vue-material-design-icons/Check.vue'
import IconClock from 'vue-material-design-icons/ClockOutline.vue'
import IconDelete from 'vue-material-design-icons/Delete.vue'
import IconLink from 'vue-material-design-icons/LinkVariant.vue'
import IconOpenInNew from 'vue-material-design-icons/OpenInNew.vue'
import RoomDetailDialog from './RoomDetailDialog.vue'
import StatusDot from './StatusDot.vue'
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
const detailOpen = ref(false)

const shortUuid = computed(() => props.room.uuid.replace(/-/g, '').slice(0, 8))

const title = computed(() => props.room.name?.trim() || shortUuid.value)

const isExpired = computed(() => props.room.expiresAt <= now.value)

const ttl = computed(() => formatDuration(props.room.expiresAt - now.value))
const createdAgo = computed(() => formatRelativePast(now.value - props.room.createdAt))

const live = computed(() => props.room.live)

/**
 * Footer viewers count: rendered as the live `connectedCount` when known,
 * `0` when the daemon reachable but room empty, or `—` when live state
 * isn't available at all (daemon offline / not configured).
 */
const viewersDisplay = computed(() => {
	if (!live.value) {
		return '—'
	}
	return String(live.value.connectedCount)
})

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
 * Open the detail dialog for this room. Triggered both by clicking the
 * card body and by the "View details" entry in the actions menu.
 */
function openDetail() {
	detailOpen.value = true
}

/**
 * Forward a delete request originating from the dialog to the parent.
 *
 * @param room the room to delete
 */
function onDeleteFromDialog(room: Room) {
	emit('delete', room)
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
	cursor: pointer;
}

.room-card:hover {
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
	border-color: var(--color-border-dark, var(--color-border));
	transform: translateY(-1px);
}

.room-card:focus-visible {
	outline: 2px solid var(--color-primary-element, var(--color-primary));
	outline-offset: 2px;
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

.room-card__actions {
	cursor: default;
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
	cursor: pointer;
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
	padding-top: 8px;
	border-top: 1px solid var(--color-border);
}

.room-card__meta {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 12px;
	color: var(--color-text-maxcontrast);
	font-variant-numeric: tabular-nums;
}

.room-card__meta--active {
	color: var(--color-success-text, var(--color-main-text));
	font-weight: 600;
}

.room-card__meta--viewers {
	font-family: var(--font-monospace, monospace);
}
</style>
