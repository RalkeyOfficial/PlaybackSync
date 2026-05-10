<template>
	<div class="playbacksync-admin">
		<div v-if="!store.loaded && store.loading" class="playbacksync-admin__loading">
			<NcLoadingIcon :size="44" />
		</div>

		<template v-if="store.loaded">
			<NcSettingsSection
				:name="t('playbacksync', 'WebSocket sync tuning')"
				:description="t('playbacksync', 'Tunables that govern how the daemon negotiates joins, idle disconnects, drift correction and rate limiting. Defaults are sane for most installs.')">
				<div class="playbacksync-admin__grid">
					<NcTextField
						v-for="field in wsTuningFields"
						:key="field.key"
						v-model.number="wsTuning[field.key]"
						type="number"
						:label="field.label"
						:helperText="field.suffix"
						:min="field.min"
						:max="field.max"
						step="1"
						inputmode="numeric" />
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
					{{ t('playbacksync', 'Changing the daemon host or port requires restarting the WebSocket daemon (occ playbacksync:ws-serve) before it takes effect.') }}
				</NcNoteCard>
				<div class="playbacksync-admin__grid">
					<NcTextField
						v-model="daemon.ws_host"
						:label="t('playbacksync', 'WebSocket host')"
						:maxlength="255" />
					<NcTextField
						v-model.number="daemon.ws_port"
						type="number"
						:label="t('playbacksync', 'WebSocket port')"
						min="1"
						max="65535"
						step="1"
						inputmode="numeric" />
					<NcTextField
						v-model="daemon.ws_admin_host"
						:label="t('playbacksync', 'Admin host')"
						:maxlength="255" />
					<NcTextField
						v-model.number="daemon.ws_admin_port"
						type="number"
						:label="t('playbacksync', 'Admin port')"
						min="1"
						max="65535"
						step="1"
						inputmode="numeric" />
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
				:name="t('playbacksync', 'Room defaults')"
				:description="t('playbacksync', 'Defaults applied when rooms are created, plus the upper bounds the API enforces.')">
				<NcCheckboxRadioSwitch
					v-model="rooms.restrict_to_admins"
					type="switch">
					{{ t('playbacksync', 'Restrict room creation to administrators') }}
				</NcCheckboxRadioSwitch>
				<div class="playbacksync-admin__grid">
					<NcTextField
						v-model.number="rooms.default_ttl_seconds"
						type="number"
						:label="t('playbacksync', 'Default room TTL (seconds)')"
						min="1"
						:max="rooms.max_ttl_seconds"
						step="1"
						inputmode="numeric" />
					<NcTextField
						v-model.number="rooms.max_ttl_seconds"
						type="number"
						:label="t('playbacksync', 'Maximum room TTL (seconds)')"
						min="60"
						max="2592000"
						step="1"
						inputmode="numeric" />
					<NcTextField
						v-model.number="rooms.max_clients_per_room"
						type="number"
						:label="t('playbacksync', 'Maximum clients per room')"
						min="1"
						max="1000"
						step="1"
						inputmode="numeric" />
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
					{{ t('playbacksync', 'Regenerating the admin secret invalidates the value the running WebSocket daemon currently holds. Until the daemon is restarted (occ playbacksync:ws-serve), every admin call from PHP — kicks, presence reads — will fail. Rotate during a maintenance window or be ready to restart the daemon immediately afterwards.') }}
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
		</template>
	</div>
</template>

<script setup lang="ts">
import type { AdminSettingsSection, DaemonSettings, RoomSettings, WsTuningSettings } from '../types/adminSettings.ts'

import { showError, showSuccess } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { computed, onMounted, ref } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcSettingsSection from '@nextcloud/vue/components/NcSettingsSection'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconContentCopy from 'vue-material-design-icons/ContentCopy.vue'
import IconContentSave from 'vue-material-design-icons/ContentSave.vue'
import IconRefresh from 'vue-material-design-icons/Refresh.vue'
import { useAdminSettingsStore } from '../stores/adminSettings.ts'

interface WsTuningField {
	key: keyof WsTuningSettings
	label: string
	suffix: string
	min: number
	max: number
}

const store = useAdminSettingsStore()
const confirmOpen = ref(false)

const wsTuningFields = computed<WsTuningField[]>(() => [
	{ key: 'ws_join_timeout_ms', label: t('playbacksync', 'Join timeout (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 600_000 },
	{ key: 'ws_idle_close_ms', label: t('playbacksync', 'Idle close (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 600_000 },
	{ key: 'ws_tombstone_ms', label: t('playbacksync', 'Tombstone (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 600_000 },
	{ key: 'ws_kick_block_ms', label: t('playbacksync', 'Kick block (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 600_000 },
	{ key: 'ws_event_log_size', label: t('playbacksync', 'Event log size'), suffix: t('playbacksync', 'events'), min: 1, max: 10_000 },
	{ key: 'ws_rate_limit_events_per_sec', label: t('playbacksync', 'Rate limit (events/s)'), suffix: t('playbacksync', 'events per second'), min: 1, max: 1_000 },
	{ key: 'ws_drift_nudge_threshold_ms', label: t('playbacksync', 'Drift nudge threshold (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 60_000 },
	{ key: 'ws_drift_seek_threshold_ms', label: t('playbacksync', 'Drift seek threshold (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 60_000 },
	{ key: 'ws_drift_cooldown_ms', label: t('playbacksync', 'Drift cooldown (ms)'), suffix: t('playbacksync', 'milliseconds'), min: 0, max: 60_000 },
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

onMounted(() => {
	store.load()
})

/**
 * Persist a single section's current form state via the store.
 *
 * @param section the settings section the user clicked Save on
 */
async function save(section: AdminSettingsSection) {
	await store.saveSection(section)
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
 * Build a zeroed `WsTuningSettings` so the template's two-way bindings have a
 * stable shape during the brief window before the initial fetch resolves.
 *
 * @return a `WsTuningSettings` with every field set to 0
 */
function createEmptyWsTuning(): WsTuningSettings {
	return {
		ws_join_timeout_ms: 0,
		ws_idle_close_ms: 0,
		ws_tombstone_ms: 0,
		ws_kick_block_ms: 0,
		ws_event_log_size: 0,
		ws_rate_limit_events_per_sec: 0,
		ws_drift_nudge_threshold_ms: 0,
		ws_drift_seek_threshold_ms: 0,
		ws_drift_cooldown_ms: 0,
	}
}

/**
 * Build a zeroed `DaemonSettings` shim used as a fallback while the snapshot
 * loads, so the binding never reads from `null`.
 *
 * @return a `DaemonSettings` with empty/zero defaults
 */
function createEmptyDaemon(): DaemonSettings {
	return { ws_host: '', ws_port: 0, ws_admin_host: '', ws_admin_port: 0 }
}

/**
 * Build a zeroed `RoomSettings` shim used as a fallback while the snapshot
 * loads, so the binding never reads from `null`.
 *
 * @return a `RoomSettings` with off/zero defaults
 */
function createEmptyRooms(): RoomSettings {
	return { restrict_to_admins: false, default_ttl_seconds: 0, max_ttl_seconds: 0, max_clients_per_room: 0 }
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
	margin-top: 20px;
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

@media (max-width: 720px) {
	.playbacksync-admin__grid {
		grid-template-columns: 1fr;
	}
}
</style>
