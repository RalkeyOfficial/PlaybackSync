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
				<StatusDot :variant="status.variant" :size="12" />
				<span class="room-detail__status-label">
					{{ status.label }}
				</span>
				<span v-if="!isExpired" class="room-detail__status-ttl">
					{{ t('playbacksync', 'Expires in {ttl}', { ttl }) }}
				</span>
			</div>

			<!-- Tabs ------------------------------------------------------ -->
			<div class="room-detail__tabs" role="tablist">
				<button
					type="button"
					role="tab"
					class="room-detail__tab"
					:class="{ 'room-detail__tab--active': activeTab === 'overview' }"
					:aria-selected="activeTab === 'overview'"
					@click="activeTab = 'overview'">
					{{ t('playbacksync', 'Overview') }}
				</button>
				<button
					type="button"
					role="tab"
					class="room-detail__tab"
					:class="{ 'room-detail__tab--active': activeTab === 'eventLog' }"
					:aria-selected="activeTab === 'eventLog'"
					@click="activeTab = 'eventLog'">
					{{ t('playbacksync', 'Event log') }}
					<span
						v-if="eventLogEvents.length > 0"
						class="room-detail__tab-badge"
						:title="t('playbacksync', '{n} events buffered', { n: eventLogEvents.length })">
						{{ eventLogEvents.length }}
					</span>
				</button>
			</div>

			<div v-show="activeTab === 'overview'" class="room-detail__pane">
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

				<!-- Playback -------------------------------------------------- -->
				<section v-if="live" class="room-detail__section">
					<div class="room-detail__section-head">
						<IconPlay :size="16" />
						<h4>{{ t('playbacksync', 'Playback') }}</h4>
						<span class="room-detail__playback-pill" :class="`room-detail__playback-pill--${playbackVariant}`">
							<IconPlay v-if="playbackVariant === 'playing'" :size="14" />
							<IconBuffer v-else-if="playbackVariant === 'buffering'" :size="14" class="room-detail__spin" />
							<IconPause v-else :size="14" />
							<span>{{ playbackLabel }}</span>
							<span class="room-detail__playback-pos">{{ formattedVideoPos }}</span>
						</span>
					</div>

					<div class="room-detail__controls">
						<NcButton
							:disabled="playbackBusy"
							:aria-label="isCurrentlyPlaying
								? t('playbacksync', 'Pause playback for everyone')
								: t('playbacksync', 'Start playback for everyone')"
							@click="onTogglePlay">
							<template #icon>
								<NcLoadingIcon v-if="playbackAction === 'play' || playbackAction === 'pause'" :size="20" />
								<IconPause v-else-if="isCurrentlyPlaying" :size="20" />
								<IconPlay v-else :size="20" />
							</template>
							{{ isCurrentlyPlaying ? t('playbacksync', 'Pause') : t('playbacksync', 'Play') }}
						</NcButton>
						<NcButton
							:disabled="playbackBusy"
							:aria-label="t('playbacksync', 'Reset playback to start')"
							@click="onReset">
							<template #icon>
								<NcLoadingIcon v-if="playbackAction === 'reset'" :size="20" />
								<IconSkipBackward v-else :size="20" />
							</template>
							{{ t('playbacksync', 'Reset to start') }}
						</NcButton>
					</div>

					<form class="room-detail__seek" @submit.prevent="onSeek">
						<NcTextField
							v-model="seekInput"
							class="room-detail__seek-field"
							:label="t('playbacksync', 'Seek to')"
							:placeholder="seekPlaceholder"
							:helperText="seekHelperText"
							:error="seekInput !== '' && !canSeek"
							:disabled="playbackBusy" />
						<NcButton
							type="submit"
							:disabled="playbackBusy || !canSeek"
							:aria-label="t('playbacksync', 'Seek to entered position')">
							<template #icon>
								<NcLoadingIcon v-if="playbackAction === 'seek'" :size="20" />
								<IconArrowRight v-else :size="20" />
							</template>
							{{ t('playbacksync', 'Go') }}
						</NcButton>
					</form>
				</section>

				<!-- Connected viewers ----------------------------------------- -->
				<section v-if="live" class="room-detail__section">
					<div class="room-detail__section-head">
						<IconAccountMultiple :size="16" />
						<h4>{{ t('playbacksync', 'Connected viewers') }}</h4>
						<span class="room-detail__count-badge">{{ live.connectedCount }}</span>
						<NcLoadingIcon v-if="refreshing" :size="14" />
					</div>

					<ul v-if="live.connectedCount > 0" class="room-detail__viewers">
						<li
							v-for="chip in clientChips"
							:key="chip.clientId"
							class="room-detail__viewer">
							<span
								class="room-detail__viewer-dot"
								:style="{ backgroundColor: chip.color }" />
							<code class="room-detail__viewer-id" :title="chip.clientId">
								{{ chip.label }}
							</code>
							<span v-if="chip.isBuffering" class="room-detail__viewer-buffering">
								<IconBuffer :size="14" class="room-detail__spin" />
								{{ t('playbacksync', 'Buffering') }}
							</span>
							<NcButton
								variant="tertiary"
								:aria-label="t('playbacksync', 'Disconnect this client')"
								:title="t('playbacksync', 'Disconnect this client')"
								:disabled="kicking === chip.clientId"
								@click="onRequestKick(chip.clientId)">
								<template #icon>
									<NcLoadingIcon v-if="kicking === chip.clientId" :size="20" />
									<IconClose v-else :size="20" />
								</template>
							</NcButton>
						</li>
					</ul>
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
					<a
						class="room-detail__now-watching"
						:href="live.contentIdentity.pageUrl"
						:title="live.contentIdentity.pageUrl"
						target="_blank"
						rel="noopener noreferrer">
						<span class="room-detail__now-watching-title">
							{{ live.contentIdentity.providerId }} · {{ live.contentIdentity.episodeId }}
						</span>
						<span class="room-detail__now-watching-url">
							{{ live.contentIdentity.pageUrl }}
						</span>
					</a>
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

			<div v-show="activeTab === 'eventLog'" class="room-detail__pane room-detail__pane--log">
				<RoomEventLog
					:events="eventLogEvents"
					:state="eventLogState"
					:meta="eventLogMeta" />
			</div>
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
		<NcCheckboxRadioSwitch
			v-model="dontAskAgainKick"
			type="checkbox"
			:disabled="kicking !== null">
			{{ t('playbacksync', "Don't ask again") }}
		</NcCheckboxRadioSwitch>
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
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconAccountMultiple from 'vue-material-design-icons/AccountMultiple.vue'
import IconAccountRemove from 'vue-material-design-icons/AccountRemove.vue'
import IconArrowRight from 'vue-material-design-icons/ArrowRight.vue'
import IconCheck from 'vue-material-design-icons/Check.vue'
import IconClock from 'vue-material-design-icons/ClockOutline.vue'
import IconClose from 'vue-material-design-icons/Close.vue'
import IconCopy from 'vue-material-design-icons/ContentCopy.vue'
import IconDelete from 'vue-material-design-icons/Delete.vue'
import IconIdentifier from 'vue-material-design-icons/Identifier.vue'
import IconLink from 'vue-material-design-icons/LinkVariant.vue'
import IconBuffer from 'vue-material-design-icons/Loading.vue'
import IconMovie from 'vue-material-design-icons/MovieOpenOutline.vue'
import IconPause from 'vue-material-design-icons/Pause.vue'
import IconPlay from 'vue-material-design-icons/Play.vue'
import IconPulse from 'vue-material-design-icons/Pulse.vue'
import IconSkipBackward from 'vue-material-design-icons/SkipBackward.vue'
import IconHourglass from 'vue-material-design-icons/TimerSandComplete.vue'
import IconWeb from 'vue-material-design-icons/Web.vue'
import RoomEventLog from './RoomEventLog.vue'
import StatusDot from './StatusDot.vue'
import { useEventSource } from '../composables/useEventSource.ts'
import { useNow } from '../composables/useNow.ts'
import { getRoomStatus } from '../composables/useRoomStatus.ts'
import { SKIP_CONFIRM_KICK_CLIENT, useSkipConfirm } from '../composables/useSkipConfirm.ts'
import { buildRoomEventStreamUrl } from '../services/roomEventsApi.ts'
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

const skipKickConfirm = useSkipConfirm(SKIP_CONFIRM_KICK_CLIENT)
const dontAskAgainKick = ref(false)

/**
 * Action of the playback command currently in flight, or null when no
 * command is pending. Drives per-button loading spinners and the global
 * disabled state of every control in the row.
 */
const playbackAction = ref<'play' | 'pause' | 'seek' | 'reset' | null>(null)

/**
 * Raw seek-position input (in seconds). Kept as a string so an empty field
 * doesn't coerce to 0 and accidentally arm a "seek to 0" action.
 */
const seekInput = ref<string>('')

/**
 * The static room fields (uuid, name, URL, share link, timestamps) come
 * from the prop — they don't change while the dialog is open. The `live`
 * block prefers the fresh fetch when it's available, falling back to the
 * prop's cached value so the dialog never blanks out the count.
 */
const live = computed(() => (freshLive.value === undefined ? props.room.live : freshLive.value))

const status = computed(() => getRoomStatus(
	{ live: live.value, expiresAt: props.room.expiresAt },
	now.value,
))

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

/**
 * SSE stream of the room's event log. Lifecycle is gated to (dialog open
 * AND event-log tab active) so the FPM proxy worker only stays pinned
 * while the user is actually watching the feed.
 */
const {
	events: eventLogEvents,
	state: eventLogState,
	meta: eventLogMeta,
	start: startEventLog,
	stop: stopEventLog,
} = useEventSource(() => buildRoomEventStreamUrl(props.room.uuid))

/**
 * Currently-visible tab in the detail dialog. Defaults to `overview` on
 * each open so the dialog never lands on a stale tab.
 */
const activeTab = ref<'overview' | 'eventLog'>('overview')

watch(() => props.open, (isOpen) => {
	if (!isOpen) {
		freshLive.value = undefined
		confirmingClientId.value = null
		dontAskAgainKick.value = false
		stopEventLog()
		return
	}
	activeTab.value = 'overview'
	void refreshLive()
}, { immediate: true })

watch([() => props.open, activeTab], ([isOpen, tab]) => {
	if (isOpen && tab === 'eventLog') {
		startEventLog()
	} else {
		stopEventLog()
	}
})

watch(confirmingClientId, (value) => {
	if (value === null) {
		dontAskAgainKick.value = false
	}
})

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
 * Treat both `playing` and `buffering` as "currently playing" for the
 * toggle button: pressing it should pause the room in either case. Only a
 * truly paused room shows the Play affordance.
 */
const isCurrentlyPlaying = computed(() => (
	playbackVariant.value === 'playing' || playbackVariant.value === 'buffering'
))

const playbackBusy = computed(() => playbackAction.value !== null)

/**
 * Parsed seconds value for the seek input. `null` while the input is empty
 * or syntactically invalid, so `canSeek` and `onSeek` can branch on one
 * source of truth.
 */
const parsedSeekSeconds = computed(() => parseSeekInput(seekInput.value))

const canSeek = computed(() => parsedSeekSeconds.value !== null)

const seekPlaceholder = computed(() => formatVideoPos(live.value?.videoPos ?? 0))

const seekHelperText = computed(() => {
	if (seekInput.value !== '' && !canSeek.value) {
		return t('playbacksync', 'Use mm:ss or h:mm:ss (or plain seconds).')
	}
	if (canSeek.value) {
		return t('playbacksync', 'Jump to {time}.', {
			time: formatVideoPos(parsedSeekSeconds.value ?? 0),
		})
	}
	return t('playbacksync', 'e.g. 2:47 or 1:05:30')
})

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
 * Parse a seek input string into a non-negative seconds count. Accepts
 * `mm:ss`, `h:mm:ss`, and bare integers (treated as seconds). Returns null
 * for empty, malformed, or negative input so callers can fall back to a
 * disabled state without throwing.
 *
 * Lower components (minutes, seconds) must be under 60; the hours component
 * is unbounded so a 3-hour movie can be seeked to.
 *
 * @param raw the value typed into the seek field
 */
function parseSeekInput(raw: string): number | null {
	const trimmed = raw.trim()
	if (trimmed === '') {
		return null
	}
	const parts = trimmed.split(':').map((p) => p.trim())
	if (parts.some((p) => p === '' || !/^\d+$/.test(p))) {
		return null
	}
	const nums = parts.map((p) => Number.parseInt(p, 10))
	if (nums.length === 0 || nums.length > 3) {
		return null
	}
	// Right-align into [hours, minutes, seconds] so a 2-part input is mm:ss
	// and a 1-part input is bare seconds, matching how people read a clock.
	const padded: [number, number, number] = [0, 0, 0]
	for (let i = 0; i < nums.length; i++) {
		padded[3 - nums.length + i] = nums[i]
	}
	const [h, m, s] = padded
	if (m >= 60 || s >= 60) {
		return null
	}
	return h * 3600 + m * 60 + s
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
 * Open the confirmation dialog for the chosen client — or skip the prompt
 * and run the kick directly if the user has previously silenced it.
 *
 * @param clientId the daemon-issued opaque hex identifier from the chip
 */
function onRequestKick(clientId: string) {
	if (skipKickConfirm.value) {
		void performKick(clientId)
		return
	}
	confirmingClientId.value = clientId
}

/**
 * Run the confirmed kick from the dialog: persist the "don't ask again"
 * choice (if any), then perform the kick.
 */
async function onConfirmKick() {
	const clientId = confirmingClientId.value
	if (clientId === null || kicking.value !== null) {
		return
	}
	if (dontAskAgainKick.value) {
		skipKickConfirm.value = true
	}
	await performKick(clientId)
}

/**
 * Hit the kick API, refresh the live block, surface a toast, and close the
 * confirmation dialog. The detail dialog itself stays open so the owner can
 * see the chip disappear and confirm the outcome.
 *
 * @param clientId the client to disconnect
 */
async function performKick(clientId: string) {
	if (kicking.value !== null) {
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

/**
 * Run a playback command against the daemon, then refresh the modal's live
 * state to reconcile with whatever the daemon now reports. The store handles
 * the optimistic UI update on the room list itself; this just keeps the
 * modal's locally-fetched `freshLive` in sync.
 *
 * @param action   the command to send
 * @param videoPos target seconds for `seek`; ignored otherwise
 */
async function runPlaybackCommand(
	action: 'play' | 'pause' | 'seek' | 'reset',
	videoPos?: number,
) {
	if (playbackAction.value !== null) {
		return
	}
	playbackAction.value = action
	try {
		const ok = await roomsStore.sendPlaybackCommand(props.room.uuid, action, videoPos)
		if (ok) {
			await refreshLive()
		}
	} finally {
		playbackAction.value = null
	}
}

/**
 *
 */
function onTogglePlay() {
	void runPlaybackCommand(isCurrentlyPlaying.value ? 'pause' : 'play')
}

/**
 *
 */
function onReset() {
	void runPlaybackCommand('reset')
}

/**
 *
 */
function onSeek() {
	const parsed = parsedSeekSeconds.value
	if (parsed === null) {
		return
	}
	void runPlaybackCommand('seek', parsed)
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

.room-detail__tabs {
	display: flex;
	padding: 2px;
	background-color: var(--color-background-dark);
	border-radius: var(--border-radius-large, 12px);
}

.room-detail__tab {
	margin-inline-start: unset !important;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	flex: 1;
	justify-content: center;
	padding: 8px 12px;
	border: none;
	border-radius: var(--border-radius, 8px);
	background: transparent;
	color: var(--color-text-maxcontrast);
	font-size: 13px;
	font-weight: 600;
	cursor: pointer;
	transition: background-color 80ms ease, color 80ms ease;
}

.room-detail__tab:hover {
	background-color: var(--color-background-hover, var(--color-background-dark));
	color: var(--color-main-text);
}

.room-detail__tab--active {
	background-color: var(--color-main-background);
	color: var(--color-main-text);
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.room-detail__tab-badge {
	min-width: 22px;
	padding: 1px 7px;
	border-radius: 999px;
	background-color: var(--color-primary-element, var(--color-primary));
	color: var(--color-primary-element-text, var(--color-primary-text));
	font-size: 11px;
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}

.room-detail__pane {
	display: flex;
	flex-direction: column;
	gap: 18px;
}

.room-detail__pane--log {
	padding-top: 4px;
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

.room-detail__playback-pill {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	margin-inline-start: auto;
	padding: 4px 10px;
	border-radius: 999px;
	font-size: 12px;
	font-weight: 500;
	background-color: var(--color-background-dark);
	color: var(--color-main-text);
}

.room-detail__playback-pill--playing {
	background-color: rgba(46, 160, 67, 0.18);
	color: var(--color-success-text, var(--color-main-text));
}

.room-detail__playback-pill--buffering {
	background-color: rgba(245, 159, 0, 0.2);
	color: var(--color-warning-text, var(--color-main-text));
}

.room-detail__playback-pos {
	font-family: var(--font-monospace, monospace);
	font-variant-numeric: tabular-nums;
	letter-spacing: 0.04em;
}

.room-detail__controls {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.room-detail__seek {
	display: flex;
	align-items: flex-end;
	gap: 8px;
}

.room-detail__seek-field {
	flex: 1;
	min-width: 0;
}

.room-detail__viewers {
	display: flex;
	flex-direction: column;
	gap: 4px;
	margin: 0;
	padding: 0;
	list-style: none;
}

.room-detail__viewer {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 8px 6px 10px;
	border-radius: var(--border-radius);
	background-color: var(--color-background-dark);
}

.room-detail__viewer-dot {
	flex: 0 0 auto;
	width: 10px;
	height: 10px;
	border-radius: 50%;
}

.room-detail__viewer-id {
	flex: 1;
	min-width: 0;
	padding: 0;
	background: none;
	font-family: var(--font-monospace, monospace);
	font-size: 13px;
	color: var(--color-main-text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.room-detail__viewer-buffering {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 8px;
	border-radius: 999px;
	background-color: rgba(245, 159, 0, 0.2);
	color: var(--color-warning-text, var(--color-main-text));
	font-size: 11px;
	font-weight: 500;
}

.room-detail__now-watching {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 10px 12px;
	border-radius: var(--border-radius);
	background-color: var(--color-background-dark);
	color: var(--color-main-text);
	text-decoration: none;
	overflow: hidden;
}

.room-detail__now-watching:hover,
.room-detail__now-watching:focus-visible {
	background-color: var(--color-background-hover, var(--color-background-dark));
}

.room-detail__now-watching-title {
	font-size: 13px;
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.room-detail__now-watching-url {
	font-family: var(--font-monospace, monospace);
	font-size: 11px;
	color: var(--color-text-maxcontrast);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
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

.room-detail__spin {
	display: inline-flex;
	animation: room-detail-spin 1s linear infinite;
}

@keyframes room-detail-spin {
	from { transform: rotate(0deg); }
	to { transform: rotate(360deg); }
}
</style>
