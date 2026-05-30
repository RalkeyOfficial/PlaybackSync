<template>
	<div class="playbacksync-admin">
		<div v-if="!store.loaded && store.loading" class="playbacksync-admin__loading">
			<NcLoadingIcon :size="44" />
		</div>

		<template v-if="store.loaded">
			<NcSettingsSection
				v-if="updates"
				:name="t('playbacksync', 'Updates')"
				:description="t('playbacksync', 'PlaybackSync is installed from GitHub rather than the Nextcloud App Store, so it checks the project releases page for newer versions. Nothing is ever installed automatically.')">
				<NcNoteCard :type="updates.updateAvailable ? 'warning' : 'success'">
					<span v-if="updates.updateAvailable">
						{{ t('playbacksync', 'Version {latest} is available — you have {current}.', { latest: updates.latestVersion, current: updates.currentVersion }) }}
					</span>
					<span v-else>
						{{ t('playbacksync', 'You are on the latest version ({current}).', { current: updates.currentVersion }) }}
					</span>
				</NcNoteCard>
				<p class="playbacksync-admin__update-meta">
					{{ lastCheckedLabel }}
				</p>
				<div class="playbacksync-admin__update-controls">
					<NcCheckboxRadioSwitch
						:modelValue="updates.enabled"
						type="switch"
						@update:modelValue="(v) => store.setUpdateCheckEnabled(v)">
						{{ t('playbacksync', 'Automatically check for updates daily') }}
					</NcCheckboxRadioSwitch>
					<div class="playbacksync-admin__update-buttons">
						<NcButton
							v-if="updates.updateAvailable"
							variant="primary"
							:href="updates.releaseUrl"
							target="_blank"
							rel="noopener noreferrer">
							<template #icon>
								<IconOpenInNew :size="20" />
							</template>
							{{ t('playbacksync', 'View release') }}
						</NcButton>
						<NcButton
							variant="secondary"
							:disabled="store.checkingForUpdates"
							@click="store.checkForUpdates()">
							<template #icon>
								<NcLoadingIcon v-if="store.checkingForUpdates" :size="20" />
								<IconRefresh v-else :size="20" />
							</template>
							{{ t('playbacksync', 'Check now') }}
						</NcButton>
					</div>
				</div>
			</NcSettingsSection>

			<NcSettingsSection
				:name="t('playbacksync', 'WebSocket sync tuning')"
				:description="t('playbacksync', 'Tunables that govern how the daemon negotiates joins, idle disconnects, drift correction and rate limiting. Defaults are sane for most installs.')">
				<div class="playbacksync-admin__grid">
					<NcTextField
						v-for="field in wsTuningFields"
						:key="field.key"
						:modelValue="numberInput(wsTuning[field.key])"
						type="number"
						:label="field.label"
						:helperText="field.suffix"
						:placeholder="String(field.placeholder)"
						:min="field.min"
						:max="field.max"
						step="1"
						inputmode="numeric"
						@update:modelValue="(v) => wsTuning[field.key] = parseNumberInput(v)" />
				</div>
				<div class="playbacksync-admin__actions">
					<NcButton
						variant="primary"
						:disabled="store.saving === 'wsTuning'"
						@click="save('wsTuning')">
						<template #icon>
							<NcLoadingIcon v-if="store.saving === 'wsTuning'" :size="20" />
							<IconContentSave v-else :size="20" />
						</template>
						{{ t('playbacksync', 'Save') }}
					</NcButton>
				</div>
			</NcSettingsSection>

			<NcSettingsSection
				:name="t('playbacksync', 'Daemon binding')"
				:description="t('playbacksync', 'Network endpoints the WebSocket daemon binds to and the admin control channel PHP uses to talk to it.')">
				<NcNoteCard type="warning">
					{{ t('playbacksync', 'Changing the daemon host or port requires restarting the WebSocket daemon before it takes effect — however it is supervised on this server (systemd, Docker Compose, or a manual run).') }}
				</NcNoteCard>
				<div class="playbacksync-admin__grid">
					<NcTextField
						:modelValue="stringInput(daemon.ws_host)"
						:label="t('playbacksync', 'WebSocket host')"
						:placeholder="PLACEHOLDERS.daemon.ws_host"
						:maxlength="255"
						@update:modelValue="(v) => daemon.ws_host = parseStringInput(v)" />
					<NcTextField
						:modelValue="numberInput(daemon.ws_port)"
						type="number"
						:label="t('playbacksync', 'WebSocket port')"
						:placeholder="String(PLACEHOLDERS.daemon.ws_port)"
						min="1"
						max="65535"
						step="1"
						inputmode="numeric"
						@update:modelValue="(v) => daemon.ws_port = parseNumberInput(v)" />
					<NcTextField
						:modelValue="stringInput(daemon.ws_admin_host)"
						:label="t('playbacksync', 'Admin host')"
						:placeholder="PLACEHOLDERS.daemon.ws_admin_host"
						:maxlength="255"
						@update:modelValue="(v) => daemon.ws_admin_host = parseStringInput(v)" />
					<NcTextField
						:modelValue="numberInput(daemon.ws_admin_port)"
						type="number"
						:label="t('playbacksync', 'Admin port')"
						:placeholder="String(PLACEHOLDERS.daemon.ws_admin_port)"
						min="1"
						max="65535"
						step="1"
						inputmode="numeric"
						@update:modelValue="(v) => daemon.ws_admin_port = parseNumberInput(v)" />
				</div>
				<div class="playbacksync-admin__actions">
					<NcButton
						variant="primary"
						:disabled="store.saving === 'daemon'"
						@click="save('daemon')">
						<template #icon>
							<NcLoadingIcon v-if="store.saving === 'daemon'" :size="20" />
							<IconContentSave v-else :size="20" />
						</template>
						{{ t('playbacksync', 'Save') }}
					</NcButton>
				</div>
			</NcSettingsSection>

			<NcSettingsSection
				:name="t('playbacksync', 'Daemon control')"
				:description="t('playbacksync', 'Restart the WebSocket daemon without opening a terminal. It exits gracefully and its supervisor starts a fresh process; connected viewers reconnect automatically within a second or two.')">
				<div class="playbacksync-admin__daemon-control">
					<NcButton
						variant="primary"
						wide
						:disabled="store.restarting"
						class="playbacksync-admin__restart-button"
						@click="restartConfirmOpen = true">
						<template #icon>
							<NcLoadingIcon v-if="store.restarting" :size="24" />
							<IconRestart v-else :size="24" />
						</template>
						{{ t('playbacksync', 'Restart daemon') }}
					</NcButton>
				</div>
			</NcSettingsSection>

			<NcSettingsSection
				:name="t('playbacksync', 'Room defaults')"
				:description="t('playbacksync', 'Defaults applied when rooms are created, plus the upper bounds the API enforces.')">
				<NcCheckboxRadioSwitch
					:modelValue="rooms.restrict_to_admins ?? false"
					type="switch"
					@update:modelValue="(v) => rooms.restrict_to_admins = v">
					{{ t('playbacksync', 'Restrict room creation to administrators') }}
				</NcCheckboxRadioSwitch>
				<div class="playbacksync-admin__grid">
					<NcTextField
						:modelValue="numberInput(rooms.default_ttl_seconds)"
						type="number"
						:label="t('playbacksync', 'Default room TTL (seconds)')"
						:placeholder="String(PLACEHOLDERS.rooms.default_ttl_seconds)"
						min="1"
						:max="rooms.max_ttl_seconds ?? undefined"
						step="1"
						inputmode="numeric"
						@update:modelValue="(v) => rooms.default_ttl_seconds = parseNumberInput(v)" />
					<NcTextField
						:modelValue="numberInput(rooms.max_ttl_seconds)"
						type="number"
						:label="t('playbacksync', 'Maximum room TTL (seconds)')"
						:placeholder="String(PLACEHOLDERS.rooms.max_ttl_seconds)"
						min="60"
						max="2592000"
						step="1"
						inputmode="numeric"
						@update:modelValue="(v) => rooms.max_ttl_seconds = parseNumberInput(v)" />
					<NcTextField
						:modelValue="numberInput(rooms.max_clients_per_room)"
						type="number"
						:label="t('playbacksync', 'Maximum clients per room')"
						:placeholder="String(PLACEHOLDERS.rooms.max_clients_per_room)"
						min="1"
						max="1000"
						step="1"
						inputmode="numeric"
						@update:modelValue="(v) => rooms.max_clients_per_room = parseNumberInput(v)" />
				</div>
				<div class="playbacksync-admin__actions">
					<NcButton
						variant="primary"
						:disabled="store.saving === 'rooms'"
						@click="save('rooms')">
						<template #icon>
							<NcLoadingIcon v-if="store.saving === 'rooms'" :size="20" />
							<IconContentSave v-else :size="20" />
						</template>
						{{ t('playbacksync', 'Save') }}
					</NcButton>
				</div>
			</NcSettingsSection>

			<NcSettingsSection
				:name="t('playbacksync', 'Security')"
				:description="t('playbacksync', 'The shared secret PHP uses to authenticate against the daemon admin channel. Rotation is destructive — see the warning below before regenerating.')">
				<NcNoteCard type="warning">
					{{ t('playbacksync', 'Regenerating the admin secret invalidates the value the running WebSocket daemon currently holds. Until the daemon is restarted, every admin call from PHP — kicks, presence reads — will fail. Rotate during a maintenance window or be ready to restart the daemon immediately afterwards.') }}
				</NcNoteCard>
				<div class="playbacksync-admin__secret">
					<NcTextField
						:modelValue="store.secret?.masked ?? ''"
						:label="t('playbacksync', 'Admin shared secret')"
						readonly />
					<div class="playbacksync-admin__secret-actions">
						<NcButton variant="secondary" @click="copySecret">
							<template #icon>
								<IconContentCopy :size="20" />
							</template>
							{{ t('playbacksync', 'Copy') }}
						</NcButton>
						<NcButton
							variant="warning"
							:disabled="store.regenerating"
							@click="confirmOpen = true">
							<template #icon>
								<NcLoadingIcon v-if="store.regenerating" :size="20" />
								<IconRefresh v-else :size="20" />
							</template>
							{{ t('playbacksync', 'Regenerate') }}
						</NcButton>
					</div>
				</div>
			</NcSettingsSection>

			<NcSettingsSection
				:name="t('playbacksync', 'Recent activity')"
				:description="t('playbacksync', 'Live cross-room feed of playback, presence and admin events from the running daemon. Events are kept in memory only — they reset when the daemon restarts.')">
				<div v-if="eventLogDegraded" class="playbacksync-admin__event-warning">
					<NcNoteCard type="warning">
						{{ t('playbacksync', 'Event log is temporarily unavailable.') }}
					</NcNoteCard>
				</div>
				<div class="playbacksync-admin__event-filters">
					<NcCheckboxRadioSwitch
						v-for="filter in categoryFilters"
						:key="filter.key"
						:modelValue="enabledCategories.has(filter.key)"
						type="switch"
						@update:modelValue="(checked) => toggleCategory(filter.key, checked)">
						{{ filter.label }}
					</NcCheckboxRadioSwitch>
				</div>
				<RoomEventLog
					:events="filteredEvents"
					:state="eventLogState"
					:meta="eventLogMeta"
					:roomNames="roomNames"
					showRoom />
			</NcSettingsSection>

			<NcDialog
				:name="t('playbacksync', 'Regenerate admin secret?')"
				:open="confirmOpen"
				size="normal"
				@update:open="onConfirmOpenChange">
				<p class="playbacksync-admin__confirm">
					{{ t('playbacksync', 'This will rotate the admin secret. The running WebSocket daemon will continue to use the old secret until it is restarted — admin endpoints will fail in the meantime. Continue?') }}
				</p>
				<template #actions>
					<NcButton variant="tertiary" :disabled="store.regenerating" @click="confirmOpen = false">
						{{ t('playbacksync', 'Cancel') }}
					</NcButton>
					<NcButton variant="warning" :disabled="store.regenerating" @click="confirmRegenerate">
						<template #icon>
							<NcLoadingIcon v-if="store.regenerating" :size="20" />
							<IconRefresh v-else :size="20" />
						</template>
						{{ t('playbacksync', 'Regenerate') }}
					</NcButton>
				</template>
			</NcDialog>

			<NcDialog
				:name="t('playbacksync', 'Restart WebSocket daemon?')"
				:open="restartConfirmOpen"
				size="normal"
				@update:open="onRestartConfirmOpenChange">
				<p class="playbacksync-admin__confirm">
					{{ t('playbacksync', 'This stops the running daemon and relies on its supervisor (Docker Compose, systemd) to start a fresh one. Connected viewers reconnect within a second or two. If the daemon is not supervised it will not come back automatically.') }}
				</p>
				<template #actions>
					<NcButton variant="tertiary" :disabled="store.restarting" @click="restartConfirmOpen = false">
						{{ t('playbacksync', 'Cancel') }}
					</NcButton>
					<NcButton variant="primary" :disabled="store.restarting" @click="confirmRestart">
						<template #icon>
							<NcLoadingIcon v-if="store.restarting" :size="20" />
							<IconRestart v-else :size="20" />
						</template>
						{{ t('playbacksync', 'Restart daemon') }}
					</NcButton>
				</template>
			</NcDialog>
		</template>
	</div>
</template>

<script setup lang="ts">
import type { AdminSettingsSection, DaemonSettings, RoomSettings, WsTuningSettings } from '../types/adminSettings.ts'
import type { EventCategory } from '../types/event.ts'

import { showError, showSuccess } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcSettingsSection from '@nextcloud/vue/components/NcSettingsSection'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconContentCopy from 'vue-material-design-icons/ContentCopy.vue'
import IconContentSave from 'vue-material-design-icons/ContentSave.vue'
import IconOpenInNew from 'vue-material-design-icons/OpenInNew.vue'
import IconRefresh from 'vue-material-design-icons/Refresh.vue'
import IconRestart from 'vue-material-design-icons/Restart.vue'
import RoomEventLog from '../components/RoomEventLog.vue'
import { useEventSource } from '../composables/useEventSource.ts'
import { buildAdminEventStreamUrl } from '../services/adminEventsApi.ts'
import { useAdminSettingsStore } from '../stores/adminSettings.ts'

interface WsTuningField {
	key: keyof WsTuningSettings
	label: string
	suffix: string
	min: number
	max: number
	placeholder: number
}

const store = useAdminSettingsStore()
const confirmOpen = ref(false)
const restartConfirmOpen = ref(false)

const updates = computed(() => store.updates)

// Human-readable "when did we last hear from GitHub" line under the banner.
const lastCheckedLabel = computed(() => {
	const checkedAt = store.updates?.lastCheckedAt ?? null
	if (checkedAt === null) {
		return t('playbacksync', 'Not checked yet.')
	}
	return t('playbacksync', 'Last checked {datetime}.', { datetime: new Date(checkedAt * 1000).toLocaleString() })
})

// Placeholder values displayed in empty inputs. These mirror
// `SettingsDefaults` in PHP and only surface when the admin has manually
// deleted a key (because EnsureDefaultSettings seeds every key on install).
// They are *suggestions*, never substituted into the form's actual value.
const PLACEHOLDERS = {
	wsTuning: {
		ws_join_timeout_ms: 5_000,
		ws_idle_close_ms: 30_000,
		ws_tombstone_ms: 30_000,
		ws_kick_block_ms: 30_000,
		ws_event_log_size: 200,
		ws_rate_limit_events_per_sec: 10,
		ws_drift_nudge_threshold_ms: 200,
		ws_drift_seek_threshold_ms: 500,
		ws_drift_cooldown_ms: 3_000,
	},
	daemon: {
		ws_host: '127.0.0.1',
		ws_port: 8765,
		ws_admin_host: '127.0.0.1',
		ws_admin_port: 8766,
	},
	rooms: {
		default_ttl_seconds: 86_400,
		max_ttl_seconds: 86_400,
		max_clients_per_room: 50,
	},
} as const

const wsTuningFields = computed<WsTuningField[]>(() => [
	{ key: 'ws_join_timeout_ms', label: t('playbacksync', 'Join timeout (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 600_000, placeholder: PLACEHOLDERS.wsTuning.ws_join_timeout_ms },
	{ key: 'ws_idle_close_ms', label: t('playbacksync', 'Idle close (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 600_000, placeholder: PLACEHOLDERS.wsTuning.ws_idle_close_ms },
	{ key: 'ws_tombstone_ms', label: t('playbacksync', 'Tombstone (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 600_000, placeholder: PLACEHOLDERS.wsTuning.ws_tombstone_ms },
	{ key: 'ws_kick_block_ms', label: t('playbacksync', 'Kick block (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 600_000, placeholder: PLACEHOLDERS.wsTuning.ws_kick_block_ms },
	{ key: 'ws_event_log_size', label: t('playbacksync', 'Event log size'), suffix: t('playbacksync', 'events'), min: 1, max: 10_000, placeholder: PLACEHOLDERS.wsTuning.ws_event_log_size },
	{ key: 'ws_rate_limit_events_per_sec', label: t('playbacksync', 'Rate limit (events/s)'), suffix: t('playbacksync', 'events per second'), min: 1, max: 1_000, placeholder: PLACEHOLDERS.wsTuning.ws_rate_limit_events_per_sec },
	{ key: 'ws_drift_nudge_threshold_ms', label: t('playbacksync', 'Drift nudge threshold (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 60_000, placeholder: PLACEHOLDERS.wsTuning.ws_drift_nudge_threshold_ms },
	{ key: 'ws_drift_seek_threshold_ms', label: t('playbacksync', 'Drift seek threshold (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 60_000, placeholder: PLACEHOLDERS.wsTuning.ws_drift_seek_threshold_ms },
	{ key: 'ws_drift_cooldown_ms', label: t('playbacksync', 'Drift cooldown (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 60_000, placeholder: PLACEHOLDERS.wsTuning.ws_drift_cooldown_ms },
])

// Non-null shims so the template doesn't have to chain `?.` everywhere; the
// surrounding `v-if="store.loaded"` guarantees these are populated by the time
// any field is rendered.
const wsTuning = computed<WsTuningSettings>({
	get: () => store.wsTuning ?? createEmptyWsTuning(),
	set: (value) => { store.wsTuning = value },
})
const daemon = computed<DaemonSettings>({
	get: () => store.daemon ?? createEmptyDaemon(),
	set: (value) => { store.daemon = value },
})
const rooms = computed<RoomSettings>({
	get: () => store.rooms ?? createEmptyRooms(),
	set: (value) => { store.rooms = value },
})

const {
	state: eventLogState,
	events: eventLogEvents,
	meta: eventLogMeta,
	degraded: eventLogDegraded,
	start: startEventLog,
	stop: stopEventLog,
} = useEventSource(() => buildAdminEventStreamUrl())

// Local map of `roomUuid → human-friendly name`. Populated as `room_created`
// and `room_renamed` envelopes stream in so the row chips can render names
// even when the admin doesn't own the room.
const roomNames = reactive<Record<string, string>>({})

interface CategoryFilter {
	key: EventCategory
	label: string
}

const categoryFilters = computed<CategoryFilter[]>(() => [
	{ key: 'playback', label: t('playbacksync', 'Playback') },
	{ key: 'presence', label: t('playbacksync', 'Presence') },
	{ key: 'lifecycle', label: t('playbacksync', 'Lifecycle') },
	{ key: 'admin', label: t('playbacksync', 'Admin') },
])

const enabledCategories = ref<Set<EventCategory>>(new Set<EventCategory>(['playback', 'presence', 'lifecycle', 'admin']))

const filteredEvents = computed(() => {
	const enabled = enabledCategories.value
	return eventLogEvents.value.filter((e) => enabled.has(e.category))
})

/**
 * Toggle a category filter in the local set. Triggers reactivity by
 * reassigning the ref to a fresh Set since native Set mutations are not
 * deeply reactive.
 *
 * @param category which event category to toggle
 * @param enabled  whether it should be visible
 */
function toggleCategory(category: EventCategory, enabled: boolean) {
	const next = new Set(enabledCategories.value)
	if (enabled) {
		next.add(category)
	} else {
		next.delete(category)
	}
	enabledCategories.value = next
}

onMounted(() => {
	store.load()
	startEventLog()
})

onBeforeUnmount(() => {
	stopEventLog()
})

// Watch streamed events for room-name updates so chips have something better
// than a raw UUID. `lifecycle` events carry the friendly name in `data`.
watch(eventLogEvents, (events) => {
	for (const event of events) {
		if (!event.roomUuid) {
			continue
		}
		if (event.type === 'room_created' || event.type === 'room_renamed') {
			const data = event.data as { name?: string, to?: string } | null
			const name = data?.name ?? data?.to
			if (typeof name === 'string' && name !== '') {
				roomNames[event.roomUuid] = name
			}
		}
	}
}, { deep: false })

/**
 * Persist a single section's current form state via the store.
 *
 * @param section the settings section the user clicked Save on
 */
async function save(section: AdminSettingsSection) {
	const ok = await store.saveSection(section)
	if (!ok) {
		return
	}
	// Daemon host/port changes can't be hot-reloaded (they'd need the socket
	// rebound), so offer a restart. The tuning and room-default sections hold
	// keys the daemon reads, so apply those to the running daemon in place —
	// no reconnect.
	if (section === 'daemon') {
		restartConfirmOpen.value = true
	} else if (section === 'wsTuning' || section === 'rooms') {
		await store.reloadDaemon()
	}
}

/**
 * Copy the masked admin secret to the user's clipboard. We only ever surface
 * the masked form here — the plaintext value never leaves the server — so
 * this is mostly useful for cross-referencing across rotations.
 */
async function copySecret() {
	const masked = store.secret?.masked ?? ''
	if (masked === '') {
		return
	}
	try {
		await navigator.clipboard.writeText(masked)
		showSuccess(t('playbacksync', 'Secret copied'))
	} catch {
		showError(t('playbacksync', 'Could not copy to clipboard.'))
	}
}

/**
 * Honour the destructive-action confirm dialog: rotate the secret only when
 * the admin clicks the warning-coloured Regenerate button, then dismiss.
 */
async function confirmRegenerate() {
	const ok = await store.regenerateSecret()
	if (ok) {
		confirmOpen.value = false
	}
}

/**
 * Forward the dialog's open-state change. Suppresses dismissal while a
 * rotation is in flight so the user cannot close the dialog mid-request.
 *
 * @param value the new open state requested by NcDialog
 */
function onConfirmOpenChange(value: boolean) {
	if (!value && store.regenerating) {
		return
	}
	confirmOpen.value = value
}

/**
 * Honour the restart confirm dialog: trigger the daemon restart only on the
 * explicit click, and dismiss once it has come back up. On failure (e.g. no
 * supervisor) the dialog stays open so the admin can retry or cancel.
 */
async function confirmRestart() {
	const ok = await store.restartDaemon()
	if (ok) {
		restartConfirmOpen.value = false
	}
}

/**
 * Forward the restart dialog's open-state change, suppressing dismissal while a
 * restart is in flight so the spinner can't be cancelled mid-request.
 *
 * @param value the new open state requested by NcDialog
 */
function onRestartConfirmOpenChange(value: boolean) {
	if (!value && store.restarting) {
		return
	}
	restartConfirmOpen.value = value
}

/**
 * Build an all-null `WsTuningSettings` so the template bindings have a stable
 * shape during the brief window before `store.load()` resolves. The form is
 * hidden behind `v-if="store.loaded"` so this is never actually rendered, but
 * Vue still needs the reactive shape to exist.
 *
 * @return a `WsTuningSettings` with every field set to `null`
 */
function createEmptyWsTuning(): WsTuningSettings {
	return {
		ws_join_timeout_ms: null,
		ws_idle_close_ms: null,
		ws_tombstone_ms: null,
		ws_kick_block_ms: null,
		ws_event_log_size: null,
		ws_rate_limit_events_per_sec: null,
		ws_drift_nudge_threshold_ms: null,
		ws_drift_seek_threshold_ms: null,
		ws_drift_cooldown_ms: null,
	}
}

/**
 * Build an all-null `DaemonSettings` shim used while the snapshot loads.
 *
 * @return a `DaemonSettings` with every field set to `null`
 */
function createEmptyDaemon(): DaemonSettings {
	return { ws_host: null, ws_port: null, ws_admin_host: null, ws_admin_port: null }
}

/**
 * Build an all-null `RoomSettings` shim used while the snapshot loads.
 *
 * @return a `RoomSettings` with every field set to `null`
 */
function createEmptyRooms(): RoomSettings {
	return { restrict_to_admins: null, default_ttl_seconds: null, max_ttl_seconds: null, max_clients_per_room: null }
}

/**
 * Translate a possibly-null numeric field into the value bound to the
 * NcTextField — empty string when the field has never been persisted, the
 * number as-is otherwise. NcInputField calls `.toString()` on its modelValue,
 * so we must never hand it a raw `null`.
 *
 * @param value the field value from the store
 * @return the value to pass to `:modelValue`
 */
function numberInput(value: number | null): number | string {
	return value ?? ''
}

/**
 * Parse the `update:modelValue` emit from a number-type NcTextField back into
 * the nullable shape the store holds. An empty input becomes `null` so the
 * save-side patch builder strips the key.
 *
 * @param value the value emitted by NcTextField
 * @return the parsed number, or `null` for empty / unparseable input
 */
function parseNumberInput(value: string | number): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null
	}
	if (value === '') {
		return null
	}
	const n = Number(value)
	return Number.isFinite(n) ? n : null
}

/**
 * Translate a possibly-null string field into the value bound to NcTextField.
 *
 * @param value the field value from the store
 * @return empty string when null, the original string otherwise
 */
function stringInput(value: string | null): string {
	return value ?? ''
}

/**
 * Parse the `update:modelValue` emit from a string-type NcTextField back into
 * the nullable shape the store holds. Empty input becomes `null`.
 *
 * @param value the value emitted by NcTextField
 * @return the trimmed string, or `null` when empty
 */
function parseStringInput(value: string | number): string | null {
	const str = typeof value === 'string' ? value : String(value)
	return str === '' ? null : str
}
</script>

<style scoped>
.playbacksync-admin {
	max-width: 900px;
}

.playbacksync-admin__loading {
	display: flex;
	justify-content: center;
	padding: 48px 0;
}

.playbacksync-admin__grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 16px 20px;
	margin-top: 16px;
}

.playbacksync-admin__actions {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-top: 20px;
}

.playbacksync-admin__daemon-control {
	margin-top: 12px;
	max-width: 360px;
}

.playbacksync-admin__update-meta {
	margin: 8px 2px 12px;
	color: var(--color-text-maxcontrast);
	font-size: 0.9em;
}

.playbacksync-admin__update-controls {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	flex-wrap: wrap;
}

.playbacksync-admin__update-buttons {
	display: flex;
	gap: 8px;
}

/* Give the restart action real presence — this is a deliberate operational
   action, not a routine Save. */
.playbacksync-admin__restart-button :deep(.button-vue) {
	min-height: 52px;
	font-size: 1.1em;
}

.playbacksync-admin__secret {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin-top: 16px;
	max-width: 480px;
}

.playbacksync-admin__secret-actions {
	display: flex;
	gap: 8px;
}

.playbacksync-admin__confirm {
	margin: 8px 4px;
	line-height: 1.5;
}

.playbacksync-admin__event-filters {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 16px;
	margin: 8px 0 12px;
}

.playbacksync-admin__event-warning {
	margin-bottom: 8px;
}

@media (max-width: 720px) {
	.playbacksync-admin__grid {
		grid-template-columns: 1fr;
	}
}
</style>
