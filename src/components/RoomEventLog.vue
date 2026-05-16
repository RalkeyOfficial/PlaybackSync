<template>
	<div class="event-log">
		<div class="event-log__head">
			<span class="event-log__live" :class="`event-log__live--${liveDot}`">
				<span class="event-log__live-dot" />
				{{ liveLabel }}
			</span>
			<span v-if="meta" class="event-log__meta" :title="metaTooltip">
				{{ t('playbacksync', '{n} buffered', { n: meta.backfillCount }) }}
			</span>
			<span v-if="reset" class="event-log__reset" :title="resetTooltip">
				{{ t('playbacksync', 'The event log was reset (daemon restarted).') }}
			</span>
		</div>

		<ol v-if="events.length > 0" class="event-log__list">
			<li
				v-for="event in displayEvents"
				:key="event.id"
				class="event-log__row"
				:class="[`event-log__row--${event.category}`, `event-log__row--type-${event.type}`]">
				<span
					class="event-log__icon"
					:class="`event-log__icon--type-${event.type}`"
					:title="event.category">
					<component :is="iconFor(event.type, event.category)" :size="16" />
				</span>
				<div class="event-log__body">
					<div class="event-log__line">
						<span class="event-log__type">{{ labelFor(event) }}</span>
						<span
							v-if="showRoom && event.roomUuid"
							class="event-log__room"
							:title="event.roomUuid">
							{{ roomChipLabel(event.roomUuid) }}
						</span>
						<span class="event-log__actor" :class="`event-log__actor--${event.actor}`">
							{{ actorLabel(event) }}
						</span>
						<span class="event-log__time" :title="formatAbsolute(event.ts)">
							{{ formatRelativePast(now - event.ts) }}
						</span>
					</div>
					<div
						v-if="dataSummary(event)"
						class="event-log__detail"
						:title="dataSummary(event)">
						{{ dataSummary(event) }}
					</div>
				</div>
			</li>
		</ol>

		<p v-else class="event-log__empty">
			{{ t('playbacksync', 'No events recorded yet.') }}
		</p>
	</div>
</template>

<script setup lang="ts">
import type { EventLogEntry, EventStreamMeta, EventStreamState } from '../types/event.ts'

import { translate as t } from '@nextcloud/l10n'
import { computed } from 'vue'
import IconAccountMinus from 'vue-material-design-icons/AccountMinus.vue'
import IconAccountPlus from 'vue-material-design-icons/AccountPlus.vue'
import IconAccountRemove from 'vue-material-design-icons/AccountRemove.vue'
import IconCog from 'vue-material-design-icons/Cog.vue'
import IconDelete from 'vue-material-design-icons/Delete.vue'
import IconSeek from 'vue-material-design-icons/FastForward.vue'
import IconKey from 'vue-material-design-icons/KeyChange.vue'
import IconPause from 'vue-material-design-icons/Pause.vue'
import IconPlay from 'vue-material-design-icons/Play.vue'
import IconPlusCircle from 'vue-material-design-icons/PlusCircle.vue'
import IconRename from 'vue-material-design-icons/RenameOutline.vue'
import IconShield from 'vue-material-design-icons/ShieldCrown.vue'
import IconSkipBackward from 'vue-material-design-icons/SkipBackward.vue'
import { useNow } from '../composables/useNow.ts'

const props = withDefaults(defineProps<{
	events: EventLogEntry[]
	state: EventStreamState
	meta: EventStreamMeta | null
	/** Hard cap on how many recent rows to render. Older events stay in-state. */
	maxRows?: number
	/** When true, prepends a compact room chip (`#abcd1234 · {name}`) to every row. */
	showRoom?: boolean
	/** Map of `roomUuid → display name` for the optional room chip. */
	roomNames?: Record<string, string>
}>(), {
	maxRows: 100,
	showRoom: false,
	roomNames: () => ({}),
})

const now = useNow()

/**
 * Slice the most recent `maxRows` events in reverse-chronological order so
 * the newest entries appear at the top. Vue treats the reversed copy as a
 * different array each render, which is what we want — the underlying
 * `props.events` is append-only.
 */
const displayEvents = computed(() => {
	const cap = props.maxRows
	const len = props.events.length
	const start = Math.max(0, len - cap)
	return props.events.slice(start).reverse()
})

const liveDot = computed<'open' | 'pending' | 'down'>(() => {
	if (props.state === 'open') {
		return 'open'
	}
	if (props.state === 'connecting') {
		return 'pending'
	}
	return 'down'
})

const liveLabel = computed(() => {
	switch (props.state) {
		case 'open': return t('playbacksync', 'Live')
		case 'connecting': return t('playbacksync', 'Reconnecting…')
		default: return t('playbacksync', 'Disconnected')
	}
})

/**
 * True when the consumer's last seen id (from the meta record) is greater
 * than the daemon's current counter — meaning the daemon restarted and our
 * view is no longer contiguous with what we saw before.
 */
const reset = computed(() => {
	const m = props.meta
	if (!m || props.events.length === 0) {
		return false
	}
	// If the first event we just received has id 1, the daemon counter has
	// rolled back — almost certainly a fresh process.
	return m.backfilledFromId > 0 && props.events[0]?.id === 1
})

const resetTooltip = computed(() => {
	const m = props.meta
	if (!m) {
		return ''
	}
	return formatAbsolute(m.daemonStartedAtMs)
})

const metaTooltip = computed(() => {
	const m = props.meta
	if (!m) {
		return ''
	}
	return t('playbacksync', 'Daemon started {time}', { time: formatAbsolute(m.daemonStartedAtMs) })
})

/**
 * Pick the icon component for a specific event type, falling back to a
 * category-level default and finally to a cog so every row renders an icon.
 *
 * @param type     event type from the wire envelope
 * @param category event category from the wire envelope, used as fallback
 */
function iconFor(type: string, category: string) {
	switch (type) {
		case 'play': return IconPlay
		case 'pause': return IconPause
		case 'seek': return IconSeek
		case 'reset': return IconSkipBackward
		case 'client_joined': return IconAccountPlus
		case 'client_left': return IconAccountMinus
		case 'client_kicked': return IconAccountRemove
		case 'room_created': return IconPlusCircle
		case 'room_renamed': return IconRename
		case 'room_deleted': return IconDelete
		case 'settings_updated': return IconCog
		case 'admin_secret_rotated': return IconKey
		case 'cursor_change': return IconSkipBackward
		case 'playlist_update': return IconPlusCircle
	}
	switch (category) {
		case 'playback': return IconPlay
		case 'presence': return IconAccountPlus
		case 'admin': return IconShield
		default: return IconCog
	}
}

/**
 * Human-readable label for the row's main line. Falls back to the raw type
 * string when no translation matches so a new event type still renders.
 *
 * @param event the entry to label
 */
function labelFor(event: EventLogEntry): string {
	switch (event.type) {
		case 'play': return t('playbacksync', 'Played')
		case 'pause': return t('playbacksync', 'Paused')
		case 'seek': return t('playbacksync', 'Seeked')
		case 'reset': return t('playbacksync', 'Reset to start')
		case 'client_joined': return t('playbacksync', 'Client joined')
		case 'client_left': return t('playbacksync', 'Client left')
		case 'client_kicked': return t('playbacksync', 'Client was kicked')
		case 'room_created': return t('playbacksync', 'Room created')
		case 'room_renamed': return t('playbacksync', 'Room renamed')
		case 'room_deleted': return t('playbacksync', 'Room deleted')
		case 'settings_updated': return t('playbacksync', 'Settings updated')
		case 'admin_secret_rotated': return t('playbacksync', 'Admin secret rotated')
		case 'cursor_change': return t('playbacksync', 'Cursor changed')
		case 'playlist_update': return t('playbacksync', 'Playlist updated')
		default: return event.type
	}
}

/**
 * Compact actor chip text. For `client` we show the nickname; for
 * `owner`/`admin` we show the userId; `system` has no actor.
 *
 * @param event the entry whose actor should be labelled
 */
function actorLabel(event: EventLogEntry): string {
	if (event.actor === 'system') {
		return t('playbacksync', 'system')
	}
	if (event.actor === 'client') {
		return event.actorId ?? t('playbacksync', 'client')
	}
	if (event.actor === 'owner') {
		return event.actorId ?? t('playbacksync', 'owner')
	}
	return event.actorId ?? t('playbacksync', 'admin')
}

/**
 * Secondary line — type-specific data summary. Returns an empty string when
 * there's nothing useful to surface so the markup can skip the sub-line.
 *
 * @param event the entry whose data should be summarised
 */
function dataSummary(event: EventLogEntry): string {
	if (event.type === 'seek') {
		const pos = (event.data?.value ?? event.data?.videoPos) as number | undefined
		if (typeof pos === 'number') {
			return t('playbacksync', 'to {time}', { time: formatVideoPos(pos) })
		}
	}
	if (event.type === 'client_left') {
		const nickname = event.data?.nickname as string | undefined
		const reason = event.data?.reason as string | undefined
		if (nickname && reason) {
			return t('playbacksync', '{nickname} · reason: {reason}', { nickname, reason })
		}
		if (nickname) {
			return nickname
		}
		if (reason) {
			return t('playbacksync', 'reason: {reason}', { reason })
		}
	}
	if (event.type === 'client_joined' || event.type === 'client_kicked') {
		const nickname = event.data?.nickname as string | undefined
		if (nickname) {
			return nickname
		}
	}
	if (event.type === 'room_renamed') {
		const from = event.data?.from as string | undefined
		const to = event.data?.to as string | undefined
		if (from && to) {
			return t('playbacksync', '{from} → {to}', { from, to })
		}
	}
	if (event.type === 'settings_updated') {
		const changes = event.data?.changes as Array<{ key: string, from: unknown, to: unknown }> | undefined
		if (Array.isArray(changes)) {
			if (changes.length === 0) {
				return t('playbacksync', 'no changes')
			}
			return changes
				.map((c) => `${c.key}: ${formatSettingValue(c.from)} → ${formatSettingValue(c.to)}`)
				.join('; ')
		}
		// Legacy buffered envelope: only the list of touched keys is known.
		const keys = event.data?.keys
		if (Array.isArray(keys)) {
			return (keys as string[]).join(', ')
		}
	}
	if (event.type === 'room_created') {
		const name = event.data?.name as string | undefined
		const ttl = event.data?.ttlSeconds as number | undefined
		const parts: string[] = []
		if (name) {
			parts.push(name)
		}
		if (typeof ttl === 'number') {
			parts.push(t('playbacksync', 'TTL {seconds}s', { seconds: ttl }))
		}
		if (parts.length > 0) {
			return parts.join(' · ')
		}
	}
	if (event.type === 'room_deleted') {
		const name = event.data?.name as string | undefined
		if (name) {
			return name
		}
	}
	return ''
}

/**
 * Render a settings value (string / int / bool / null) as a compact display
 * string for the change log. Strings get quoted so the from→to delimiter
 * can't be confused with the value itself.
 *
 * @param value the value to render
 */
function formatSettingValue(value: unknown): string {
	if (value === null || value === undefined) {
		return '∅'
	}
	if (typeof value === 'boolean') {
		return value ? 'true' : 'false'
	}
	if (typeof value === 'string') {
		return `"${value}"`
	}
	if (typeof value === 'number') {
		return String(value)
	}
	return JSON.stringify(value)
}

/**
 * Compact room chip label — short UUID prefix plus the friendly name when
 * one is available. Falls back to just the prefix so a brand-new room (no
 * name memoised yet) still renders something.
 *
 * @param roomUuid the envelope's roomUuid
 */
function roomChipLabel(roomUuid: string): string {
	const short = roomUuid.slice(0, 8)
	const name = props.roomNames[roomUuid]
	return name ? `#${short} · ${name}` : `#${short}`
}

/**
 * Render "ms ago" as the largest unit. Mirrors the helper in
 * `RoomDetailDialog` so timestamps feel consistent across the dashboard.
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
 * @param seconds non-negative playback position
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
</script>

<style scoped>
.event-log {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.event-log__head {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 12px;
	color: var(--color-text-maxcontrast);
}

.event-log__live {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 8px;
	border-radius: 999px;
	font-weight: 500;
	background-color: var(--color-background-dark);
}

.event-log__live-dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background-color: currentColor;
}

.event-log__live--open {
	color: var(--color-success-text, #2ea043);
}

.event-log__live--open .event-log__live-dot {
	box-shadow: 0 0 0 2px rgba(46, 160, 67, 0.2);
	animation: event-log-pulse 1.6s ease-in-out infinite;
}

.event-log__live--pending {
	color: var(--color-warning-text, #d29922);
}

.event-log__live--down {
	color: var(--color-error-text, #f85149);
}

.event-log__reset {
	margin-inline-start: auto;
	color: var(--color-warning-text, #d29922);
	font-style: italic;
}

.event-log__list {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 0;
	padding: 0;
	list-style: none;
	max-height: 360px;
	overflow-y: auto;
	border-radius: var(--border-radius);
	border: 1px solid var(--color-border);
	background-color: var(--color-background-dark);
}

.event-log__row {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 8px 12px;
	border-bottom: 1px solid var(--color-border);
}

.event-log__row:last-child {
	border-bottom: none;
}

.event-log__row {
	/* Per-type CSS custom property — defaulted to a neutral grey and
	 * overridden by the `--type-*` rules below. The icon container and the
	 * row's left border both read this so a single declaration drives both. */
	--event-color: #6e7681;
	--event-tint: rgba(110, 118, 129, 0.16);
	border-inline-start: 3px solid var(--event-color);
}

.event-log__row--type-play         { --event-color: #2ea043; --event-tint: rgba(46, 160, 67, 0.18); }

.event-log__row--type-pause        { --event-color: #d29922; --event-tint: rgba(210, 153, 34, 0.18); }

.event-log__row--type-seek         { --event-color: #58a6ff; --event-tint: rgba(88, 166, 255, 0.18); }

.event-log__row--type-reset        { --event-color: #db6d28; --event-tint: rgba(219, 109, 40, 0.18); }

.event-log__row--type-client_joined { --event-color: #3fb950; --event-tint: rgba(63, 185, 80, 0.18); }

.event-log__row--type-client_left   { --event-color: #8b949e; --event-tint: rgba(139, 148, 158, 0.18); }

.event-log__row--type-client_kicked { --event-color: #f85149; --event-tint: rgba(248, 81, 73, 0.18); }

.event-log__row--type-room_created  { --event-color: #58a6ff; --event-tint: rgba(88, 166, 255, 0.18); }

.event-log__row--type-room_renamed  { --event-color: #bc8cff; --event-tint: rgba(188, 140, 255, 0.18); }

.event-log__row--type-room_deleted  { --event-color: #f85149; --event-tint: rgba(248, 81, 73, 0.18); }

.event-log__row--type-settings_updated { --event-color: #d29922; --event-tint: rgba(210, 153, 34, 0.18); }

.event-log__row--type-admin_secret_rotated { --event-color: #f85149; --event-tint: rgba(248, 81, 73, 0.18); }

.event-log__icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 auto;
	width: 26px;
	height: 26px;
	border-radius: 50%;
	background-color: var(--event-tint);
	color: var(--event-color);
}

.event-log__body {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.event-log__line {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 13px;
}

.event-log__type {
	font-weight: 600;
	color: var(--color-main-text);
}

.event-log__room {
	font-family: var(--font-monospace, monospace);
	font-size: 11px;
	padding: 1px 6px;
	border-radius: 4px;
	background-color: var(--color-background-hover, var(--color-background-dark));
	color: var(--color-text-maxcontrast);
	max-width: 24ch;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.event-log__actor {
	font-family: var(--font-monospace, monospace);
	font-size: 11px;
	padding: 1px 6px;
	border-radius: 999px;
	background-color: var(--color-background-hover, var(--color-background-dark));
	color: var(--color-text-maxcontrast);
	max-width: 16ch;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.event-log__actor--owner {
	color: var(--color-primary-element, var(--color-primary));
	background-color: rgba(8, 109, 232, 0.12);
}

.event-log__actor--admin {
	position: relative;
	overflow: visible;
	color: #3d2c00;
	/* Solid gold base so animation gaps never show the chip's dark fallback.
	 * The gradient on top tiles (repeat-x) so position can move continuously
	 * without ever exposing the underlying colour. */
	background-color: #f5c542;
	background-image: linear-gradient(110deg,
		#d4a017 0%,
		#fff1a8 25%,
		#ffd86b 50%,
		#d4a017 75%,
		#fff1a8 100%);
	background-size: 200% 100%;
	background-repeat: repeat-x;
	box-shadow:
		0 0 0 1px rgba(218, 165, 32, 0.65),
		0 0 8px rgba(255, 215, 0, 0.55),
		0 0 18px rgba(255, 215, 0, 0.25);
	font-weight: 600;
	letter-spacing: 0.02em;
	text-shadow: 0 1px 0 rgba(255, 255, 255, 0.4);
	animation: admin-gold-shimmer 3.2s linear infinite;
}

.event-log__actor--admin::before,
.event-log__actor--admin::after {
	content: '';
	position: absolute;
	width: 6px;
	height: 6px;
	background:
		radial-gradient(circle, #fffbe5 0%, #ffd86b 40%, rgba(255, 215, 0, 0) 70%);
	border-radius: 50%;
	pointer-events: none;
	opacity: 0;
	will-change: transform, opacity;
}

.event-log__actor--admin::before {
	top: -3px;
	inset-inline-start: 30%;
	animation: admin-sparkle-a 2.6s ease-in-out infinite;
}

.event-log__actor--admin::after {
	bottom: -3px;
	inset-inline-end: 25%;
	animation: admin-sparkle-b 2.6s ease-in-out infinite;
	animation-delay: 1.3s;
}

@keyframes admin-gold-shimmer {
	0%   { background-position: 0 0; }
	100% { background-position: -200% 0; }
}

@keyframes admin-sparkle-a {
	0%, 100%   { opacity: 0; transform: translate(0, 0) scale(0.6); }
	30%        { opacity: 1; transform: translate(-2px, -4px) scale(1.1); }
	60%        { opacity: 0; transform: translate(-6px, -8px) scale(0.4); }
}

@keyframes admin-sparkle-b {
	0%, 100%   { opacity: 0; transform: translate(0, 0) scale(0.6); }
	30%        { opacity: 1; transform: translate(2px, 4px) scale(1.1); }
	60%        { opacity: 0; transform: translate(6px, 8px) scale(0.4); }
}

@media (prefers-reduced-motion: reduce) {
	.event-log__actor--admin {
		animation: none;
		background-position: 0 0;
	}
	.event-log__actor--admin::before,
	.event-log__actor--admin::after {
		animation: none;
	}
}

.event-log__actor--system {
	font-style: italic;
}

.event-log__time {
	margin-inline-start: auto;
	font-size: 11px;
	font-variant-numeric: tabular-nums;
	color: var(--color-text-maxcontrast);
}

.event-log__detail {
	font-size: 11px;
	color: var(--color-text-maxcontrast);
	font-family: var(--font-monospace, monospace);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.event-log__empty {
	margin: 0;
	padding: 18px;
	border-radius: var(--border-radius);
	background-color: var(--color-background-dark);
	color: var(--color-text-maxcontrast);
	font-size: 12px;
	font-style: italic;
	text-align: center;
}

.event-log__meta {
	font-variant-numeric: tabular-nums;
}

@keyframes event-log-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}
</style>
