<template>
	<div class="playlist-editor">
		<header class="playlist-editor__header">
			<div class="playlist-editor__header-meta">
				<h4 class="playlist-editor__title">
					{{ t('playbacksync', 'Playlist') }}
				</h4>
				<span class="playlist-editor__mode-chip" :class="modeBadgeClass" :title="t('playbacksync', 'Current playlist mode')" />
				<NcSelect
					class="playlist-editor__mode-picker"
					:modelValue="modeChoiceOption"
					:options="modeOptions"
					:inputLabel="t('playbacksync', 'Mode')"
					:clearable="false"
					:disabled="modeSwitching"
					label="label"
					@update:modelValue="onModePicked" />
				<span class="playlist-editor__count">
					{{ t('playbacksync', '{n} entries', { n: entries.length }) }}
				</span>
			</div>
			<div class="playlist-editor__header-actions">
				<NcButton
					:disabled="addLocked"
					:title="addLocked ? lockedHint : t('playbacksync', 'Add entry')"
					@click="addDialogOpen = true">
					<template #icon>
						<IconPlus :size="20" />
					</template>
					{{ t('playbacksync', 'Add entry') }}
				</NcButton>
				<NcButton
					variant="error"
					:disabled="clearLocked || entries.length === 0"
					:title="clearLocked ? lockedHint : t('playbacksync', 'Clear all entries')"
					@click="confirmingClear = true">
					<template #icon>
						<IconDelete :size="20" />
					</template>
					{{ t('playbacksync', 'Clear all') }}
				</NcButton>
			</div>
		</header>

		<NcEmptyContent
			v-if="entries.length === 0"
			:name="emptyTitle"
			:description="emptyHint">
			<template #icon>
				<IconPlaylistPlay :size="64" />
			</template>
		</NcEmptyContent>

		<ul v-else class="playlist-editor__list">
			<li
				v-for="entry in entries"
				:key="entry.entryId"
				class="playlist-editor__row"
				:class="{
					'playlist-editor__row--cursor': entry.entryId === cursorEntryId,
					'playlist-editor__row--stale': isStale(entry),
				}">
				<span class="playlist-editor__cursor-dot" :title="entry.entryId === cursorEntryId ? t('playbacksync', 'Current entry') : ''" />
				<div class="playlist-editor__row-main">
					<div class="playlist-editor__row-title-line">
						<span class="playlist-editor__row-pos">{{ formatPosition(entry) }}</span>
						<span class="playlist-editor__row-title">{{ entry.label || (entry.providerId + ' · ' + entry.videoId) }}</span>
					</div>
					<div class="playlist-editor__row-chips">
						<span class="playlist-editor__chip playlist-editor__chip--provider">{{ entry.providerId }}</span>
						<span class="playlist-editor__chip" :class="sourceChipClass(entry.source)">{{ sourceLabel(entry.source) }}</span>
						<span v-if="isStale(entry)" class="playlist-editor__chip playlist-editor__chip--stale" :title="staleTooltip(entry)">
							{{ t('playbacksync', 'Stale') }}
						</span>
					</div>
				</div>
				<a
					class="playlist-editor__row-open"
					:href="entry.pageUrl"
					:title="entry.pageUrl"
					target="_blank"
					rel="noopener noreferrer">
					<IconOpenInNew :size="16" />
				</a>
				<NcActions :inline="0" :forceMenu="true">
					<NcActionButton
						:disabled="entry.entryId === cursorEntryId"
						@click="onMoveCursor(entry)">
						<template #icon>
							<IconTarget :size="20" />
						</template>
						{{ t('playbacksync', 'Move cursor here') }}
					</NcActionButton>
					<NcActionButton @click="startEditLabel(entry)">
						<template #icon>
							<IconPencil :size="20" />
						</template>
						{{ t('playbacksync', 'Edit label') }}
					</NcActionButton>
					<NcActionButton
						v-if="entry.source !== 'curated'"
						@click="onPromoteToCurated(entry)">
						<template #icon>
							<IconStar :size="20" />
						</template>
						{{ t('playbacksync', 'Convert to curated') }}
					</NcActionButton>
					<NcActionButton
						:disabled="!canReorder || entry.position <= 1"
						@click="onMoveUp(entry)">
						<template #icon>
							<IconArrowUp :size="20" />
						</template>
						{{ t('playbacksync', 'Move up') }}
					</NcActionButton>
					<NcActionButton
						:disabled="!canReorder || entry.position >= entries.length"
						@click="onMoveDown(entry)">
						<template #icon>
							<IconArrowDown :size="20" />
						</template>
						{{ t('playbacksync', 'Move down') }}
					</NcActionButton>
					<NcActionButton @click="onRemove(entry)">
						<template #icon>
							<IconDelete :size="20" />
						</template>
						{{ t('playbacksync', 'Remove') }}
					</NcActionButton>
				</NcActions>
			</li>
		</ul>

		<NcNoteCard v-if="cursorBlockedEntryId !== null" type="warning">
			{{ t('playbacksync', 'This entry is the current cursor — advance the cursor to another entry before removing it.') }}
		</NcNoteCard>

		<PlaylistAddDialog
			:open="addDialogOpen"
			:roomUuid="room.uuid"
			@update:open="addDialogOpen = $event" />

		<NcDialog
			:name="t('playbacksync', 'Edit label')"
			size="small"
			:open="editLabel.entryId !== null"
			:canClose="!editLabel.saving"
			@update:open="(v) => { if (!v) editLabel.entryId = null }">
			<NcTextField
				v-model="editLabel.value"
				:label="t('playbacksync', 'Label')"
				:maxlength="200" />
			<template #actions>
				<NcButton :disabled="editLabel.saving" @click="editLabel.entryId = null">
					{{ t('playbacksync', 'Cancel') }}
				</NcButton>
				<NcButton
					variant="primary"
					:disabled="editLabel.saving"
					@click="onSaveLabel">
					<template #icon>
						<NcLoadingIcon v-if="editLabel.saving" :size="20" />
						<IconCheck v-else :size="20" />
					</template>
					{{ t('playbacksync', 'Save') }}
				</NcButton>
			</template>
		</NcDialog>

		<NcDialog
			:name="t('playbacksync', 'Lock the playlist?')"
			size="small"
			:open="confirmingLock"
			:canClose="!modeSwitching"
			@update:open="(v) => { if (!v) cancelLockConfirm() }">
			<p class="playlist-editor__confirm-prompt">
				{{ t('playbacksync', 'Existing entries stay, but no new ones can be added until you switch single mode off again.') }}
			</p>
			<template #actions>
				<NcButton :disabled="modeSwitching" @click="cancelLockConfirm">
					{{ t('playbacksync', 'Cancel') }}
				</NcButton>
				<NcButton
					variant="primary"
					:disabled="modeSwitching"
					@click="confirmLock">
					<template #icon>
						<NcLoadingIcon v-if="modeSwitching" :size="20" />
					</template>
					{{ t('playbacksync', 'Lock playlist') }}
				</NcButton>
			</template>
		</NcDialog>

		<NcDialog
			:name="t('playbacksync', 'Clear playlist?')"
			size="small"
			:open="confirmingClear"
			:canClose="!clearing"
			@update:open="(v) => { if (!v) confirmingClear = false }">
			<p class="playlist-editor__confirm-prompt">
				{{ t('playbacksync', 'This removes every entry and unsets the cursor. Connected viewers will lose their place.') }}
			</p>
			<template #actions>
				<NcButton :disabled="clearing" @click="confirmingClear = false">
					{{ t('playbacksync', 'Cancel') }}
				</NcButton>
				<NcButton
					variant="error"
					:disabled="clearing"
					@click="onConfirmClear">
					<template #icon>
						<NcLoadingIcon v-if="clearing" :size="20" />
						<IconDelete v-else :size="20" />
					</template>
					{{ t('playbacksync', 'Clear all') }}
				</NcButton>
			</template>
		</NcDialog>
	</div>
</template>

<script setup lang="ts">
import type { PlaylistEntry, PlaylistEntrySource, Room } from '../types/room.ts'

import { translate as t } from '@nextcloud/l10n'
import { computed, reactive, ref } from 'vue'
import NcActionButton from '@nextcloud/vue/components/NcActionButton'
import NcActions from '@nextcloud/vue/components/NcActions'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconArrowDown from 'vue-material-design-icons/ArrowDown.vue'
import IconArrowUp from 'vue-material-design-icons/ArrowUp.vue'
import IconCheck from 'vue-material-design-icons/Check.vue'
import IconDelete from 'vue-material-design-icons/Delete.vue'
import IconOpenInNew from 'vue-material-design-icons/OpenInNew.vue'
import IconPencil from 'vue-material-design-icons/Pencil.vue'
import IconPlaylistPlay from 'vue-material-design-icons/PlaylistPlay.vue'
import IconPlus from 'vue-material-design-icons/Plus.vue'
import IconStar from 'vue-material-design-icons/Star.vue'
import IconTarget from 'vue-material-design-icons/Target.vue'
import PlaylistAddDialog from './PlaylistAddDialog.vue'
import { useRoomsStore } from '../stores/rooms.ts'

const props = defineProps<{
	room: Room
}>()

const roomsStore = useRoomsStore()

const STALE_THRESHOLD_DAYS = 7
const STALE_THRESHOLD_SECONDS = STALE_THRESHOLD_DAYS * 24 * 3600

const addDialogOpen = ref(false)
const confirmingClear = ref(false)
const clearing = ref(false)
// Surfaces the cursor-locked warning after the user tries to remove the
// cursor entry. Cleared when they pick another row.
const cursorBlockedEntryId = ref<string | null>(null)

type ModeChoice = 'default' | 'single' | 'freeform'

interface ModeOption {
	key: ModeChoice
	label: string
}

const confirmingLock = ref(false)
const modeSwitching = ref(false)
// The mode the lock-confirm dialog is gating. Held aside so the picker
// can roll back to the room's actual mode on cancel without a flicker.
const pendingMode = ref<ModeChoice | null>(null)

interface EditLabelState {
	entryId: string | null
	value: string
	saving: boolean
}

const editLabel = reactive<EditLabelState>({ entryId: null, value: '', saving: false })

const entries = computed<PlaylistEntry[]>(() => [...props.room.playlist].sort((a, b) => a.position - b.position))
const cursorEntryId = computed(() => props.room.cursorEntryId)

const isSingleMode = computed(() => props.room.singleMode)
const isFreeformMode = computed(() => props.room.freeformMode)
const isDefaultMode = computed(() => !isSingleMode.value && !isFreeformMode.value)

const addLocked = computed(() => isSingleMode.value)
const clearLocked = computed(() => isSingleMode.value)
const canReorder = computed(() => !isSingleMode.value)

const lockedHint = computed(() => t('playbacksync', 'Locked by single mode.'))

const modeOptions = computed<ModeOption[]>(() => [
	{ key: 'default', label: t('playbacksync', 'Default mode') },
	{ key: 'single', label: t('playbacksync', 'Single mode') },
	{ key: 'freeform', label: t('playbacksync', 'Freeform mode') },
])

const currentMode = computed<ModeChoice>(() => {
	if (isSingleMode.value) {
		return 'single'
	}
	if (isFreeformMode.value) {
		return 'freeform'
	}
	return 'default'
})

const modeChoiceOption = computed<ModeOption>(() => {
	const target = pendingMode.value ?? currentMode.value
	return modeOptions.value.find((opt) => opt.key === target) ?? modeOptions.value[0]
})

const modeBadgeClass = computed(() => {
	if (isSingleMode.value) {
		return 'playlist-editor__mode-chip--single'
	}
	if (isFreeformMode.value) {
		return 'playlist-editor__mode-chip--freeform'
	}
	return 'playlist-editor__mode-chip--default'
})

const emptyTitle = computed(() => {
	if (isFreeformMode.value) {
		return t('playbacksync', 'No entries yet')
	}
	return t('playbacksync', 'Playlist is empty')
})

const emptyHint = computed(() => {
	if (isFreeformMode.value) {
		return t('playbacksync', 'Anyone who joins on a video will start the list.')
	}
	if (isDefaultMode.value) {
		return t('playbacksync', 'It will populate when a viewer joins on a page the extension can scrape, or you can add entries manually.')
	}
	return t('playbacksync', 'Add the one entry this room plays.')
})

/**
 * Decide whether an entry counts as stale — `lastSeenAt` older than the
 * `STALE_THRESHOLD_DAYS` configured constant. Computed against
 * `Date.now()` so the dim flickers on subsequent renders, but only when
 * the boundary is actually crossed.
 *
 * @param entry the entry to inspect
 */
function isStale(entry: PlaylistEntry): boolean {
	if (entry.lastSeenAt <= 0) {
		return false
	}
	const ageSeconds = Math.floor(Date.now() / 1000) - entry.lastSeenAt
	return ageSeconds > STALE_THRESHOLD_SECONDS
}

/**
 * Tooltip text for a stale entry — surfaces how long it has been since
 * the entry was last reported by a scrape, so the owner can decide
 * whether to remove it.
 *
 * @param entry the entry to inspect
 */
function staleTooltip(entry: PlaylistEntry): string {
	const ageDays = Math.floor((Math.floor(Date.now() / 1000) - entry.lastSeenAt) / 86400)
	return t('playbacksync', 'Last seen {n} days ago', { n: ageDays })
}

/**
 * Format the per-row position label. Falls back to `#1`-style ordering
 * when episode metadata isn't present.
 *
 * @param entry the entry to format
 */
function formatPosition(entry: PlaylistEntry): string {
	if (entry.seasonNumber !== null && entry.episodeNumber !== null) {
		return t('playbacksync', 'S{season}E{episode}', { season: entry.seasonNumber, episode: entry.episodeNumber })
	}
	if (entry.episodeNumber !== null) {
		return t('playbacksync', 'E{episode}', { episode: entry.episodeNumber })
	}
	return '#' + entry.position
}

/**
 * Map a source enum to a localized chip label.
 *
 * @param source the entry's `source` field
 */
function sourceLabel(source: PlaylistEntrySource): string {
	if (source === 'curated') {
		return t('playbacksync', 'Curated')
	}
	if (source === 'auto_appended') {
		return t('playbacksync', 'Auto-appended')
	}
	return t('playbacksync', 'Scraped')
}

/**
 * Map a source enum to a modifier class so each chip gets a distinct
 * background colour without inline styles.
 *
 * @param source the entry's `source` field
 */
function sourceChipClass(source: PlaylistEntrySource): string {
	if (source === 'curated') {
		return 'playlist-editor__chip--curated'
	}
	if (source === 'auto_appended') {
		return 'playlist-editor__chip--auto'
	}
	return 'playlist-editor__chip--scraped'
}

/**
 * Map a mode choice key to the `(singleMode, freeformMode)` pair the
 * server expects. The dropdown only emits one of three keys, so the
 * impossible `(true, true)` state is unrepresentable here.
 *
 * @param choice the mode the owner picked
 */
function toggleFlagsFor(choice: ModeChoice): { singleMode: boolean, freeformMode: boolean } {
	if (choice === 'single') {
		return { singleMode: true, freeformMode: false }
	}
	if (choice === 'freeform') {
		return { singleMode: false, freeformMode: true }
	}
	return { singleMode: false, freeformMode: false }
}

/**
 * Handle a selection from the mode dropdown. Switching *to* single mode
 * while the playlist has more than one entry routes through the
 * confirmation dialog; everything else fires `updateSettings` directly.
 *
 * @param option the NcSelect option object the user picked
 */
async function onModePicked(option: ModeOption | null) {
	if (option === null || modeSwitching.value) {
		return
	}
	if (option.key === currentMode.value) {
		return
	}
	if (option.key === 'single' && entries.value.length > 1) {
		pendingMode.value = 'single'
		confirmingLock.value = true
		return
	}
	await applyModeChange(option.key)
}

/**
 * Resolve the lock-confirmation dialog by actually flipping the room
 * into single mode. Called after the owner confirms in the dialog.
 */
async function confirmLock() {
	confirmingLock.value = false
	await applyModeChange('single')
}

/**
 * Drop the pending mode change and snap the dropdown back to the
 * room's current mode. Fires from the dialog Cancel button and from
 * the dialog backdrop close.
 */
function cancelLockConfirm() {
	confirmingLock.value = false
	pendingMode.value = null
}

/**
 * Push a mode change to the server via the existing rooms store action.
 * `pendingMode` is held until the request settles so the dropdown shows
 * the intent rather than flickering mid-request.
 *
 * @param choice the target mode
 */
async function applyModeChange(choice: ModeChoice) {
	const flags = toggleFlagsFor(choice)
	modeSwitching.value = true
	pendingMode.value = choice
	try {
		await roomsStore.updateSettings(props.room.uuid, flags.singleMode, flags.freeformMode)
	} finally {
		modeSwitching.value = false
		pendingMode.value = null
	}
}

/**
 * Move the cursor to the supplied entry.
 *
 * @param entry the row whose entry should become the cursor
 */
async function onMoveCursor(entry: PlaylistEntry) {
	cursorBlockedEntryId.value = null
	await roomsStore.setCursor(props.room.uuid, entry.entryId)
}

/**
 * Remove the supplied entry. Pre-flights the cursor lock so the dashboard
 * surfaces the inline warning without firing a doomed DELETE.
 *
 * @param entry the row to remove
 */
async function onRemove(entry: PlaylistEntry) {
	if (entry.entryId === cursorEntryId.value) {
		cursorBlockedEntryId.value = entry.entryId
		return
	}
	cursorBlockedEntryId.value = null
	await roomsStore.removePlaylistEntry(props.room.uuid, entry.entryId)
}

/**
 * Promote a scraped or auto-appended entry to curated so subsequent
 * scrapes can no longer overwrite its label or metadata.
 *
 * @param entry the row to promote
 */
async function onPromoteToCurated(entry: PlaylistEntry) {
	await roomsStore.updatePlaylistEntry(props.room.uuid, entry.entryId, { source: 'curated' })
}

/**
 * Shift the entry one slot earlier in the playlist. No-op at position 1.
 *
 * @param entry the row to move
 */
async function onMoveUp(entry: PlaylistEntry) {
	if (entry.position <= 1) {
		return
	}
	await roomsStore.updatePlaylistEntry(props.room.uuid, entry.entryId, { position: entry.position - 1 })
}

/**
 * Shift the entry one slot later in the playlist. No-op at the last position.
 *
 * @param entry the row to move
 */
async function onMoveDown(entry: PlaylistEntry) {
	if (entry.position >= entries.value.length) {
		return
	}
	await roomsStore.updatePlaylistEntry(props.room.uuid, entry.entryId, { position: entry.position + 1 })
}

/**
 * Open the inline label-edit dialog seeded with the entry's current label.
 *
 * @param entry the row whose label is being edited
 */
function startEditLabel(entry: PlaylistEntry) {
	editLabel.entryId = entry.entryId
	editLabel.value = entry.label ?? ''
	editLabel.saving = false
}

/**
 * Persist the in-progress label edit. Closes the dialog on success.
 */
async function onSaveLabel() {
	if (editLabel.entryId === null || editLabel.saving) {
		return
	}
	editLabel.saving = true
	try {
		const ok = await roomsStore.updatePlaylistEntry(props.room.uuid, editLabel.entryId, {
			label: editLabel.value.trim() || null,
		})
		if (ok) {
			editLabel.entryId = null
		}
	} finally {
		editLabel.saving = false
	}
}

/**
 * Fire the bulk Clear-All after the user confirms it in the dialog.
 */
async function onConfirmClear() {
	if (clearing.value) {
		return
	}
	clearing.value = true
	try {
		const ok = await roomsStore.clearPlaylist(props.room.uuid)
		if (ok) {
			confirmingClear.value = false
		}
	} finally {
		clearing.value = false
	}
}
</script>

<style scoped>
.playlist-editor {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.playlist-editor__header {
	display: flex;
	flex-wrap: wrap;
	gap: 12px;
	justify-content: space-between;
	align-items: center;
}

.playlist-editor__header-meta {
	display: flex;
	align-items: center;
	gap: 10px;
}

.playlist-editor__title {
	margin: 0;
	font-size: 1rem;
}

.playlist-editor__mode-chip {
	width: 12px;
	height: 12px;
	border-radius: 50%;
	background: var(--color-background-darker);
	flex-shrink: 0;
}

.playlist-editor__mode-chip--default {
	background: var(--color-primary-element);
}

.playlist-editor__mode-chip--single {
	background: var(--color-warning);
}

.playlist-editor__mode-chip--freeform {
	background: var(--color-success);
}

.playlist-editor__mode-picker {
	min-width: 160px;
}

.playlist-editor__count {
	color: var(--color-text-maxcontrast);
	font-size: 0.85rem;
}

.playlist-editor__header-actions {
	display: flex;
	gap: 8px;
}

.playlist-editor__list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.playlist-editor__row {
	display: grid;
	grid-template-columns: 16px 1fr auto auto;
	gap: 8px;
	align-items: center;
	padding: 8px 10px;
	border-radius: var(--border-radius);
	background: var(--color-background-hover);
}

.playlist-editor__row--cursor {
	background: var(--color-primary-element-light);
}

.playlist-editor__row--stale {
	opacity: 0.55;
}

.playlist-editor__cursor-dot {
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background: transparent;
}

.playlist-editor__row--cursor .playlist-editor__cursor-dot {
	background: var(--color-primary-element);
}

.playlist-editor__row-main {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.playlist-editor__row-title-line {
	display: flex;
	gap: 8px;
	align-items: baseline;
	min-width: 0;
}

.playlist-editor__row-pos {
	font-variant-numeric: tabular-nums;
	color: var(--color-text-maxcontrast);
	font-size: 0.85rem;
	flex-shrink: 0;
}

.playlist-editor__row-title {
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.playlist-editor__row-chips {
	display: flex;
	gap: 4px;
	flex-wrap: wrap;
}

.playlist-editor__chip {
	padding: 1px 6px;
	border-radius: 4px;
	font-size: 0.7rem;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.02em;
	background: var(--color-background-darker);
	color: var(--color-text-maxcontrast);
}

.playlist-editor__chip--provider {
	background: var(--color-background-dark);
	color: var(--color-main-text);
}

.playlist-editor__chip--curated {
	background: var(--color-warning);
	color: var(--color-primary-text);
}

.playlist-editor__chip--auto {
	background: var(--color-success);
	color: var(--color-primary-text);
}

.playlist-editor__chip--scraped {
	background: var(--color-background-darker);
}

.playlist-editor__chip--stale {
	background: var(--color-error);
	color: var(--color-primary-text);
}

.playlist-editor__row-open {
	color: var(--color-text-maxcontrast);
	padding: 4px;
	border-radius: var(--border-radius);
}

.playlist-editor__row-open:hover {
	color: var(--color-main-text);
	background: var(--color-background-darker);
}

.playlist-editor__confirm-prompt {
	margin: 0;
}
</style>
