<template>
	<NcDialog
		:name="title"
		size="normal"
		:open="open"
		:canClose="true"
		@update:open="onOpenChange">
		<div class="room-detail">
			<!-- Top status strip ------------------------------------------- -->
			<div class="room-detail__status">
				<StatusDot :variant="isExpired ? 'neutral' : 'success'" :size="12" />
				<span class="room-detail__status-label">
					{{ isExpired ? t('playbacksync', 'Expired') : t('playbacksync', 'Live') }}
				</span>
				<span v-if="!isExpired" class="room-detail__status-ttl">
					{{ t('playbacksync', 'Expires in {ttl}', { ttl }) }}
				</span>
			</div>

			<!-- URL ------------------------------------------------------- -->
			<section class="room-detail__section">
				<div class="room-detail__section-head">
					<IconWeb :size="16" />
					<h4>{{ t('playbacksync', 'Target video URL') }}</h4>
				</div>
				<div class="room-detail__field-row">
					<a
						class="room-detail__url"
						:href="room.targetUrl"
						:title="room.targetUrl"
						target="_blank"
						rel="noopener noreferrer">
						{{ room.targetUrl }}
					</a>
					<NcButton
						:aria-label="t('playbacksync', 'Copy target URL')"
						:title="t('playbacksync', 'Copy target URL')"
						@click="copy(room.targetUrl, 'targetUrl')">
						<template #icon>
							<IconCheck v-if="copied === 'targetUrl'" :size="20" />
							<IconCopy v-else :size="20" />
						</template>
					</NcButton>
				</div>
			</section>

			<!-- Share link ------------------------------------------------ -->
			<section class="room-detail__section">
				<div class="room-detail__section-head">
					<IconLink :size="16" />
					<h4>{{ t('playbacksync', 'Share link') }}</h4>
				</div>
				<div class="room-detail__field-row">
					<code class="room-detail__shared">{{ room.shareLink }}</code>
					<NcButton
						:aria-label="t('playbacksync', 'Copy share link')"
						:title="t('playbacksync', 'Copy share link')"
						@click="copy(room.shareLink, 'shareLink')">
						<template #icon>
							<IconCheck v-if="copied === 'shareLink'" :size="20" />
							<IconCopy v-else :size="20" />
						</template>
					</NcButton>
				</div>
			</section>

			<!-- Timestamps ------------------------------------------------ -->
			<section class="room-detail__section room-detail__section--grid">
				<div class="room-detail__metric">
					<div class="room-detail__metric-head">
						<IconClock :size="14" />
						<span>{{ t('playbacksync', 'Created') }}</span>
					</div>
					<div class="room-detail__metric-value">
						{{ createdAgo }}
					</div>
					<div class="room-detail__metric-meta">
						{{ formatAbsolute(room.createdAt) }}
					</div>
				</div>
				<div class="room-detail__metric">
					<div class="room-detail__metric-head">
						<IconHourglass :size="14" />
						<span>{{ isExpired ? t('playbacksync', 'Expired') : t('playbacksync', 'Expires in') }}</span>
					</div>
					<div class="room-detail__metric-value">
						{{ isExpired ? '—' : ttl }}
					</div>
					<div class="room-detail__metric-meta">
						{{ formatAbsolute(room.expiresAt) }}
					</div>
				</div>
				<div class="room-detail__metric">
					<div class="room-detail__metric-head">
						<IconPulse :size="14" />
						<span>{{ t('playbacksync', 'Last activity') }}</span>
					</div>
					<div class="room-detail__metric-value">
						{{ lastActivityRel }}
					</div>
					<div class="room-detail__metric-meta">
						{{ lastActivityAbs }}
					</div>
				</div>
			</section>

			<!-- Live state ------------------------------------------------ -->
			<section v-if="live" class="room-detail__section">
				<div class="room-detail__section-head">
					<IconAccountMultiple :size="16" />
					<h4>{{ t('playbacksync', 'Connected viewers') }}</h4>
					<span class="room-detail__count-badge">{{ live.connectedCount }}</span>
					<NcLoadingIcon v-if="refreshing" :size="14" />
				</div>

				<div class="room-detail__playback" :class="`room-detail__playback--${playbackVariant}`">
					<IconPlay v-if="playbackVariant === 'playing'" :size="16" />
					<IconBuffer v-else-if="playbackVariant === 'buffering'" :size="16" />
					<IconPause v-else :size="16" />
					<span>{{ playbackLabel }}</span>
					<span class="room-detail__playback-pos">{{ formattedVideoPos }}</span>
				</div>

				<div v-if="live.connectedCount > 0" class="room-detail__chips">
					<span
						v-for="chip in clientChips"
						:key="chip.clientId"
						class="room-detail__chip"
						:title="chip.clientId"
						:style="{ backgroundColor: chip.color }">
						{{ chip.label }}
						<IconBuffer v-if="chip.isBuffering" :size="12" />
						<button
							type="button"
							class="room-detail__chip-kick"
							:aria-label="t('playbacksync', 'Disconnect this client')"
							:title="t('playbacksync', 'Disconnect this client')"
							:disabled="kicking === chip.clientId"
							@click="onRequestKick(chip.clientId)">
							<IconAccountRemove :size="14" />
						</button>
					</span>
				</div>
				<p v-else class="room-detail__empty">
					{{ t('playbacksync', 'No viewers are currently connected.') }}
				</p>
			</section>
			<section v-else class="room-detail__section">
				<NcNoteCard type="warning">
					{{ t('playbacksync', 'Live state unavailable — the WebSocket sync server may be offline.') }}
				</NcNoteCard>
			</section>

			<!-- Content identity ------------------------------------------ -->
			<section v-if="live?.contentIdentity" class="room-detail__section">
				<div class="room-detail__section-head">
					<IconMovie :size="16" />
					<h4>{{ t('playbacksync', 'Now watching') }}</h4>
				</div>
				<dl class="room-detail__defs">
					<dt>{{ t('playbacksync', 'Provider') }}</dt>
					<dd>{{ live.contentIdentity.providerId }}</dd>
					<dt>{{ t('playbacksync', 'Episode') }}</dt>
					<dd>{{ live.contentIdentity.episodeId }}</dd>
					<dt>{{ t('playbacksync', 'Page') }}</dt>
					<dd>
						<a
							:href="live.contentIdentity.pageUrl"
							target="_blank"
							rel="noopener noreferrer">
							{{ live.contentIdentity.pageUrl }}
						</a>
					</dd>
				</dl>
			</section>

			<!-- Identity ---------------------------------------------------- -->
			<section class="room-detail__section">
				<div class="room-detail__section-head">
					<IconIdentifier :size="16" />
					<h4>{{ t('playbacksync', 'Identifier') }}</h4>
				</div>
				<code class="room-detail__uuid">{{ room.uuid }}</code>
			</section>
		</div>

		<template #actions>
			<NcButton
				variant="error"
				@click="onDelete">
				<template #icon>
					<IconDelete :size="20" />
				</template>
				{{ t('playbacksync', 'Delete room') }}
			</NcButton>
			<NcButton
				variant="primary"
				@click="onOpenChange(false)">
				{{ t('playbacksync', 'Close') }}
			</NcButton>
		</template>
	</NcDialog>

	<NcDialog
		:name="t('playbacksync', 'Disconnect client?')"
		size="small"
		:open="confirmingClientId !== null"
		:canClose="kicking === null"
		@update:open="(v) => { if (!v) { confirmingClientId = null } }">
		<p class="room-detail__confirm-prompt">
			{{ t('playbacksync', 'Disconnect client {clientId}?', { clientId: confirmingClientLabel }) }}
		</p>
		<p class="room-detail__confirm-detail">
			{{ t('playbacksync', 'They will be disconnected immediately and blocked from rejoining for 30 seconds.') }}
		</p>
		<template #actions>
			<NcButton
				:disabled="kicking !== null"
				@click="confirmingClientId = null">
				{{ t('playbacksync', 'Cancel') }}
			</NcButton>
			<NcButton
				variant="error"
				:disabled="kicking !== null"
				@click="onConfirmKick">
				<template #icon>
					<NcLoadingIcon v-if="kicking !== null" :size="20" />
					<IconAccountRemove v-else :size="20" />
				</template>
				{{ t('playbacksync', 'Disconnect') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script setup lang="ts">
import type { Room, RoomLiveState } from '../types/room.ts'

import { showError, showSuccess } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { getLoggerBuilder } from '@nextcloud/logger'
import { computed, ref, watch } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import IconAccountMultiple from 'vue-material-design-icons/AccountMultiple.vue'
import IconAccountRemove from 'vue-material-design-icons/AccountRemove.vue'
import IconCheck from 'vue-material-design-icons/Check.vue'
import IconClock from 'vue-material-design-icons/ClockOutline.vue'
import IconCopy from 'vue-material-design-icons/ContentCopy.vue'
import IconDelete from 'vue-material-design-icons/Delete.vue'
import IconIdentifier from 'vue-material-design-icons/Identifier.vue'
import IconLink from 'vue-material-design-icons/LinkVariant.vue'
import IconBuffer from 'vue-material-design-icons/Loading.vue'
import IconMovie from 'vue-material-design-icons/MovieOpenOutline.vue'
import IconPause from 'vue-material-design-icons/Pause.vue'
import IconPlay from 'vue-material-design-icons/Play.vue'
import IconPulse from 'vue-material-design-icons/Pulse.vue'
import IconHourglass from 'vue-material-design-icons/TimerSandComplete.vue'
import IconWeb from 'vue-material-design-icons/Web.vue'
import StatusDot from './StatusDot.vue'
import { useNow } from '../composables/useNow.ts'
import { getRoom } from '../services/roomsApi.ts'
import { useRoomsStore } from '../stores/rooms.ts'

const props = defineProps<{
	room: Room
	open: boolean
}>()

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void
	(e: 'delete', room: Room): void
}>()

const logger = getLoggerBuilder().setApp('playbacksync').detectUser().build()
const roomsStore = useRoomsStore()

const now = useNow()
const copied = ref<'shareLink' | 'targetUrl' | null>(null)

/**
 * Freshly-fetched live state. `null` until the dialog opens and the
 * `GET /api/v1/rooms/{uuid}` response lands; from that point on, this is
 * the source of truth for the `live` block. Reset on close so the next
 * open re-fetches.
 */
const freshLive = ref<RoomLiveState | null | undefined>(undefined)
const refreshing = ref(false)

/**
 * `clientId` of the chip the owner is being prompted to kick, or null when
 * the confirmation dialog is closed.
 */
const confirmingClientId = ref<string | null>(null)

/**
 * `clientId` of the kick currently in flight, or null when no kick is
 * pending. Used to disable both the per-chip button and the confirm-dialog
 * actions while the request is being processed.
 */
const kicking = ref<string | null>(null)

/**
 * The static room fields (uuid, name, URL, share link, timestamps) come
 * from the prop — they don't change while the dialog is open. The `live`
 * block prefers the fresh fetch when it's available, falling back to the
 * prop's cached value so the dialog never blanks out the count.
 */
const live = computed(() => (freshLive.value === undefined ? props.room.live : freshLive.value))

const confirmingClientLabel = computed(() => (
	confirmingClientId.value ? confirmingClientId.value.slice(0, 8) : ''
))

/**
 * Re-fetch the room and replace `freshLive`. Called on dialog open and
 * after a successful kick so the chip list reflects the new state.
 */
async function refreshLive() {
	refreshing.value = true
	try {
		const fresh = await getRoom(props.room.uuid)
		freshLive.value = fresh.live
	} catch (error) {
		logger.warn('Failed to refresh room detail', { error, uuid: props.room.uuid })
		// Leave the previous value visible.
	} finally {
		refreshing.value = false
	}
}

watch(() => props.open, (isOpen) => {
	if (!isOpen) {
		freshLive.value = undefined
		confirmingClientId.value = null
		return
	}
	void refreshLive()
}, { immediate: true })

const isExpired = computed(() => props.room.expiresAt <= now.value)

const shortUuid = computed(() => props.room.uuid.replace(/-/g, '').slice(0, 8))
const title = computed(() => props.room.name?.trim() || shortUuid.value)

const ttl = computed(() => formatDuration(props.room.expiresAt - now.value))
const createdAgo = computed(() => formatRelativePast(now.value - props.room.createdAt))

const lastActivityRel = computed(() => {
	if (!live.value?.lastActivityMs) {
		return '—'
	}
	const diff = now.value - live.value.lastActivityMs
	return diff < 60_000 ? t('playbacksync', 'just now') : formatRelativePast(diff)
})

const lastActivityAbs = computed(() => {
	if (!live.value?.lastActivityMs) {
		return ''
	}
	return formatAbsolute(live.value.lastActivityMs)
})

const playbackVariant = computed<'playing' | 'paused' | 'buffering'>(() => {
	const s = live.value?.playerState
	if (s === 'playing') {
		return 'playing'
	}
	if (s === 'buffering') {
		return 'buffering'
	}
	return 'paused'
})

const playbackLabel = computed(() => {
	switch (playbackVariant.value) {
		case 'playing': return t('playbacksync', 'Playing')
		case 'buffering': return t('playbacksync', 'Buffering')
		default: return t('playbacksync', 'Paused')
	}
})

const formattedVideoPos = computed(() => formatVideoPos(live.value?.videoPos ?? 0))

/**
 * Full chip list for the modal — uncapped, sorted by recency. The card
 * shows just a count; the modal is the place to actually inspect who is
 * connected.
 */
const clientChips = computed(() => {
	if (!live.value) {
		return []
	}
	return [...live.value.clients]
		.sort((a, b) => b.lastSeenMs - a.lastSeenMs)
		.map((c) => ({
			clientId: c.clientId,
			label: c.clientId.slice(0, 8),
			color: clientChipColor(c.clientId),
			isBuffering: c.isBuffering,
		}))
})

/**
 * Format a non-negative millisecond duration as the largest two units.
 *
 * @param ms duration in milliseconds; non-positive values render as "0s"
 */
function formatDuration(ms: number): string {
	if (ms <= 0) {
		return '0s'
	}
	const total = Math.floor(ms / 1000)
	const days = Math.floor(total / 86400)
	const hours = Math.floor((total % 86400) / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const seconds = total % 60
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
 * Render "ms ago" as the largest unit, with "just now" under a minute.
 *
 * @param ms how long ago the event happened, in milliseconds
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
 * Format a unix-millis timestamp as a locale-aware short string.
 *
 * @param ms unix timestamp in milliseconds
 */
function formatAbsolute(ms: number): string {
	try {
		return new Date(ms).toLocaleString()
	} catch {
		return ''
	}
}

/**
 * Render seconds as `m:ss` or `h:mm:ss`.
 *
 * @param seconds non-negative playback position; non-finite → "0:00"
 */
function formatVideoPos(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return '0:00'
	}
	const total = Math.floor(seconds)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	const ss = s < 10 ? `0${s}` : `${s}`
	if (h > 0) {
		const mm = m < 10 ? `0${m}` : `${m}`
		return `${h}:${mm}:${ss}`
	}
	return `${m}:${ss}`
}

/**
 * Stable HSL background colour derived from the clientId so the same
 * connection appears in the same shade across refreshes.
 *
 * @param clientId the daemon-issued opaque hex string
 */
function clientChipColor(clientId: string): string {
	let hash = 0
	for (let i = 0; i < clientId.length; i++) {
		hash = (hash * 31 + clientId.charCodeAt(i)) | 0
	}
	const hue = Math.abs(hash) % 360
	return `hsl(${hue}, 60%, 70%)`
}

/**
 * Two-digit zero-pad.
 *
 * @param n a non-negative integer under 100
 */
function pad(n: number): string {
	return n < 10 ? `0${n}` : `${n}`
}

/**
 * Copy a value to the clipboard, briefly toggle the `copied` indicator on
 * the corresponding button, and surface the result via a toast.
 *
 * @param value the string to copy
 * @param kind which field is being copied — drives the icon swap and toast text
 */
async function copy(value: string, kind: 'shareLink' | 'targetUrl') {
	try {
		await navigator.clipboard.writeText(value)
		copied.value = kind
		showSuccess(kind === 'shareLink'
			? t('playbacksync', 'Share link copied')
			: t('playbacksync', 'Target URL copied'))
		setTimeout(() => {
			if (copied.value === kind) {
				copied.value = null
			}
		}, 1500)
	} catch (error) {
		logger.error('Clipboard write failed', { error })
		showError(t('playbacksync', 'Could not copy to clipboard.'))
	}
}

/**
 * Forward the dialog's open-state change to the parent.
 *
 * @param value the new open state from NcDialog
 */
function onOpenChange(value: boolean) {
	emit('update:open', value)
}

/**
 * Emit a delete request and close the dialog. The parent owns the
 * confirmation prompt and the actual store-level removal.
 */
function onDelete() {
	emit('delete', props.room)
	onOpenChange(false)
}

/**
 * Open the confirmation dialog for the chosen client. Kick is irreversible,
 * so we always prompt — there's no "skip confirmation" path.
 *
 * @param clientId the daemon-issued opaque hex identifier from the chip
 */
function onRequestKick(clientId: string) {
	confirmingClientId.value = clientId
}

/**
 * Run the confirmed kick: hit the API, refresh the live block, surface a
 * toast, and close the confirmation dialog. The detail dialog itself stays
 * open so the owner can see the chip disappear and confirm the outcome.
 */
async function onConfirmKick() {
	const clientId = confirmingClientId.value
	if (clientId === null || kicking.value !== null) {
		return
	}
	kicking.value = clientId
	try {
		const ok = await roomsStore.kickClient(props.room.uuid, clientId)
		if (ok) {
			showSuccess(t('playbacksync', 'Client disconnected'))
			confirmingClientId.value = null
			await refreshLive()
		}
	} finally {
		kicking.value = null
	}
}
</script>

<style scoped>
.room-detail {
	display: flex;
	flex-direction: column;
	gap: 18px;
	padding: 4px 4px 8px;
}

.room-detail__status {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	background: linear-gradient(90deg,
		var(--color-background-hover, var(--color-background-dark)) 0%,
		var(--color-main-background) 100%);
	border-radius: var(--border-radius-large, 12px);
	border: 1px solid var(--color-border);
}

.room-detail__status-label {
	font-weight: 600;
}

.room-detail__status-ttl {
	margin-left: auto;
	font-family: var(--font-monospace, monospace);
	font-variant-numeric: tabular-nums;
	color: var(--color-text-maxcontrast);
	font-size: 13px;
}

.room-detail__section {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.room-detail__section-head {
	display: flex;
	align-items: center;
	gap: 6px;
}

.room-detail__section-head h4 {
	margin: 0;
	font-size: 13px;
	font-weight: 600;
	color: var(--color-text-maxcontrast);
	text-transform: uppercase;
	letter-spacing: 0.06em;
}

.room-detail__count-badge {
	margin-left: auto;
	min-width: 24px;
	padding: 2px 8px;
	border-radius: 999px;
	background-color: var(--color-primary-element, var(--color-primary));
	color: var(--color-primary-element-text, var(--color-primary-text));
	font-size: 11px;
	font-weight: 700;
	text-align: center;
}

.room-detail__field-row {
	display: flex;
	align-items: center;
	gap: 8px;
}

.room-detail__url,
.room-detail__shared,
.room-detail__uuid {
	flex: 1;
	display: block;
	padding: 8px 12px;
	background-color: var(--color-background-dark);
	border-radius: var(--border-radius);
	font-family: var(--font-monospace, monospace);
	font-size: 12px;
	color: var(--color-main-text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.room-detail__url {
	text-decoration: none;
}

.room-detail__url:hover,
.room-detail__url:focus-visible {
	color: var(--color-primary-element, var(--color-primary));
	text-decoration: underline;
}

.room-detail__uuid {
	user-select: all;
	letter-spacing: 0.04em;
}

.room-detail__section--grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
	gap: 10px;
}

.room-detail__metric {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 12px;
	background-color: var(--color-background-dark);
	border-radius: var(--border-radius);
}

.room-detail__metric-head {
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--color-text-maxcontrast);
}

.room-detail__metric-value {
	font-family: var(--font-monospace, monospace);
	font-size: 18px;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
	color: var(--color-main-text);
}

.room-detail__metric-meta {
	font-size: 11px;
	color: var(--color-text-maxcontrast);
}

.room-detail__playback {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 6px 12px;
	border-radius: 999px;
	font-size: 13px;
	font-weight: 500;
	background-color: var(--color-background-dark);
	color: var(--color-main-text);
	align-self: flex-start;
}

.room-detail__playback--playing {
	background-color: rgba(46, 160, 67, 0.18);
	color: var(--color-success-text, var(--color-main-text));
}

.room-detail__playback--buffering {
	background-color: rgba(245, 159, 0, 0.2);
	color: var(--color-warning-text, var(--color-main-text));
}

.room-detail__playback-pos {
	font-family: var(--font-monospace, monospace);
	font-variant-numeric: tabular-nums;
	letter-spacing: 0.04em;
}

.room-detail__chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.room-detail__chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 4px 6px 4px 10px;
	border-radius: 999px;
	font-family: var(--font-monospace, monospace);
	font-size: 12px;
	font-weight: 600;
	color: var(--color-main-text);
	letter-spacing: 0.03em;
	border: 1px solid rgba(0, 0, 0, 0.05);
}

.room-detail__chip-kick {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 18px;
	height: 18px;
	padding: 0;
	margin-inline-start: 2px;
	border: none;
	border-radius: 50%;
	background: rgba(0, 0, 0, 0.08);
	color: inherit;
	cursor: pointer;
	opacity: 0.65;
	transition: opacity 120ms ease, background-color 120ms ease;
}

.room-detail__chip-kick:hover,
.room-detail__chip-kick:focus-visible {
	opacity: 1;
	background: rgba(0, 0, 0, 0.18);
}

.room-detail__chip-kick:disabled {
	cursor: progress;
	opacity: 0.4;
}

.room-detail__confirm-prompt {
	margin: 0 0 8px;
	font-size: 14px;
	font-weight: 500;
}

.room-detail__confirm-detail {
	margin: 0 0 4px;
	font-size: 13px;
	color: var(--color-text-maxcontrast);
}

.room-detail__empty {
	margin: 0;
	font-size: 12px;
	color: var(--color-text-maxcontrast);
	font-style: italic;
}

.room-detail__defs {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 6px 14px;
	margin: 0;
}

.room-detail__defs dt {
	font-size: 12px;
	color: var(--color-text-maxcontrast);
	text-transform: uppercase;
	letter-spacing: 0.06em;
}

.room-detail__defs dd {
	margin: 0;
	font-size: 13px;
	color: var(--color-main-text);
	overflow-wrap: anywhere;
}
</style>
