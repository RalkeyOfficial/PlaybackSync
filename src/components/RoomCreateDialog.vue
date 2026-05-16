<template>
	<NcDialog
		:name="t('playbacksync', 'Create a new room')"
		size="normal"
		:open="open"
		@update:open="onOpenChange">
		<form class="room-create-form" @submit.prevent="submit">
			<NcTextField
				v-model="name"
				:label="t('playbacksync', 'Name (optional)')"
				:maxlength="100" />

			<NcTextField
				v-model="bootstrapUrl"
				type="url"
				:label="bootstrapUrlLabel"
				placeholder="https://example.com/watch/..."
				:error="!!bootstrapUrlError"
				:helperText="bootstrapUrlError ?? bootstrapUrlHelper"
				required />

			<div v-if="singleMode" class="room-create-form__seed">
				<div v-if="lookupPending" class="room-create-form__seed-status">
					<NcLoadingIcon :size="16" />
					<span>{{ t('playbacksync', 'Looking up the video…') }}</span>
				</div>
				<div
					v-else-if="lookupResult && lookupResult.label"
					class="room-create-form__seed-preview">
					<span class="room-create-form__seed-chip">{{ lookupResult.providerName || lookupResult.providerId }}</span>
					<span class="room-create-form__seed-title">{{ lookupResult.label }}</span>
				</div>
				<div
					v-else-if="lookupResult && !lookupResult.label"
					class="room-create-form__seed-preview room-create-form__seed-preview--missing">
					{{ t('playbacksync', 'Title not found, will use URL.') }}
				</div>
				<div
					v-else-if="seedLookupFailed"
					class="room-create-form__seed-preview room-create-form__seed-preview--error">
					{{ t('playbacksync', 'Could not detect a video on this page.') }}
				</div>

				<NcTextField
					v-model="label"
					:label="t('playbacksync', 'Video title')"
					:maxlength="200"
					:helperText="t('playbacksync', 'We’ll auto-fill this from the page when we can. You can override it here.')"
					@update:modelValue="onLabelInput" />
			</div>

			<NcSelect
				v-model="ttlPreset"
				:options="ttlOptions"
				:inputLabel="t('playbacksync', 'Expires after')"
				:reduce="reduceTtlOption"
				:clearable="false" />

			<div v-if="ttlPreset === CUSTOM_TTL" class="ttl-custom">
				<NcTextField
					v-model.number="customHours"
					type="number"
					:label="t('playbacksync', 'Hours')"
					:error="!!customTtlError"
					:helperText="customTtlError ?? customTtlHelper"
					min="0"
					:max="String(maxCustomHours)"
					step="1"
					inputmode="numeric" />
				<NcTextField
					v-model.number="customMinutes"
					type="number"
					:label="t('playbacksync', 'Minutes')"
					:error="!!customTtlError"
					min="0"
					max="59"
					step="1"
					inputmode="numeric" />
			</div>

			<fieldset class="room-create-form__modes">
				<legend>{{ t('playbacksync', 'Playlist behaviour') }}</legend>
				<NcCheckboxRadioSwitch
					:modelValue="singleMode"
					:disabled="freeformMode"
					type="switch"
					@update:checked="onSingleModeChange">
					{{ t('playbacksync', 'Single mode') }}
				</NcCheckboxRadioSwitch>
				<p class="room-create-form__mode-hint">
					{{ t('playbacksync', 'Lock the playlist to one video. Use for a single shared clip.') }}
				</p>
				<NcCheckboxRadioSwitch
					:modelValue="freeformMode"
					:disabled="singleMode"
					type="switch"
					@update:checked="onFreeformModeChange">
					{{ t('playbacksync', 'Freeform mode') }}
				</NcCheckboxRadioSwitch>
				<p class="room-create-form__mode-hint">
					{{ t('playbacksync', 'Follow whoever switches video, append on the fly. Use for movie nights.') }}
				</p>
				<p v-if="singleMode || freeformMode" class="room-create-form__mode-hint room-create-form__mode-hint--exclusive">
					{{ t('playbacksync', 'Single and freeform are mutually exclusive — only one can be on.') }}
				</p>
			</fieldset>
		</form>

		<template #actions>
			<NcButton variant="tertiary" :disabled="creating" @click="onOpenChange(false)">
				{{ t('playbacksync', 'Cancel') }}
			</NcButton>
			<NcButton variant="primary" :disabled="!canSubmit || creating" @click="submit">
				<template #icon>
					<NcLoadingIcon v-if="creating" :size="20" />
					<IconPlus v-else :size="20" />
				</template>
				{{ t('playbacksync', 'Create room') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script setup lang="ts">
import type { MetadataLookupResult } from '../services/metadataApi.ts'

import { loadState } from '@nextcloud/initial-state'
import { translate as t } from '@nextcloud/l10n'
import { computed, ref, watch } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconPlus from 'vue-material-design-icons/Plus.vue'
import { lookupMetadata } from '../services/metadataApi.ts'
import { useRoomsStore } from '../stores/rooms.ts'

const props = defineProps<{
	open: boolean
}>()

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void
}>()

const roomsStore = useRoomsStore()

const CUSTOM_TTL = -1
const FALLBACK_MAX_TTL_SECONDS = 86400

// Server-supplied cap from the admin settings page; bake it in at module
// load since it's a per-page constant and the dialog can mount many times.
const MAX_TTL_SECONDS = loadInitialMaxTtl()

const name = ref('')
const bootstrapUrl = ref('')
const customHours = ref(1)
const customMinutes = ref(0)
const singleMode = ref(false)
const freeformMode = ref(false)
const label = ref('')
// Tracks whether the owner has typed in the label field. While false, the
// debounced lookup is free to overwrite the label with the fetched title.
const labelTouched = ref(false)
const lookupPending = ref(false)
const lookupResult = ref<MetadataLookupResult | null>(null)
// True after a debounced lookup ran but the server returned `unsupported_url`
// (or any failure). The preview line surfaces a "couldn't detect a video"
// note and submit stays blocked.
const seedLookupFailed = ref(false)
let lookupDebounceHandle: ReturnType<typeof setTimeout> | null = null
let lookupRunId = 0

interface TtlOption {
	value: number
	label: string
}

const ALL_TTL_PRESETS: TtlOption[] = [
	{ value: 3600, label: t('playbacksync', '1 hour') },
	{ value: 21600, label: t('playbacksync', '6 hours') },
	{ value: 43200, label: t('playbacksync', '12 hours') },
	{ value: 86400, label: t('playbacksync', '24 hours') },
]

const ttlOptions = computed<TtlOption[]>(() => {
	const fitting = ALL_TTL_PRESETS.filter((opt) => opt.value <= MAX_TTL_SECONDS)
	return [
		...fitting,
		{ value: CUSTOM_TTL, label: t('playbacksync', 'Custom…') },
	]
})

const defaultTtlPreset = computed<number>(() => {
	const fitting = ALL_TTL_PRESETS.filter((opt) => opt.value <= MAX_TTL_SECONDS)
	if (fitting.length === 0) {
		return CUSTOM_TTL
	}
	return fitting[fitting.length - 1].value
})

const ttlPreset = ref<number>(defaultTtlPreset.value)

const maxCustomHours = computed(() => Math.max(1, Math.ceil(MAX_TTL_SECONDS / 3600)))

const formattedMaxTtl = computed(() => formatTtlLimit(MAX_TTL_SECONDS))

const customTtlHelper = computed(() => t('playbacksync', 'Between 1 minute and {limit}.', { limit: formattedMaxTtl.value }))

/**
 * Pull the numeric TTL value out of a vue-select option object so NcSelect's
 * v-model works with primitive numbers instead of the option wrapper.
 *
 * @param option the option object emitted by NcSelect
 * @return the seconds value the option represents
 */
function reduceTtlOption(option: TtlOption): number {
	return option.value
}

const creating = computed(() => roomsStore.creating)

const bootstrapUrlError = computed<string | null>(() => {
	const value = bootstrapUrl.value.trim()
	if (value === '') {
		return null
	}
	if (!/^https?:\/\/\S+/i.test(value)) {
		return t('playbacksync', 'Must be a valid http(s) URL.')
	}
	return null
})

const bootstrapUrlLabel = computed(() => {
	if (singleMode.value) {
		return t('playbacksync', 'Video URL')
	}
	return t('playbacksync', 'Bootstrap URL')
})

const bootstrapUrlHelper = computed(() => {
	if (singleMode.value) {
		return t('playbacksync', 'The video everyone will watch. The playlist will be locked to just this one.')
	}
	return t('playbacksync', 'The page participants will be redirected to.')
})

const customTtlSeconds = computed(() => {
	const hours = Number.isFinite(customHours.value) ? Math.trunc(customHours.value) : 0
	const minutes = Number.isFinite(customMinutes.value) ? Math.trunc(customMinutes.value) : 0
	return hours * 3600 + minutes * 60
})

const customTtlError = computed<string | null>(() => {
	if (ttlPreset.value !== CUSTOM_TTL) {
		return null
	}
	const seconds = customTtlSeconds.value
	if (seconds < 60) {
		return t('playbacksync', 'Must be at least 1 minute.')
	}
	if (seconds > MAX_TTL_SECONDS) {
		return t('playbacksync', 'Must be {limit} or less.', { limit: formattedMaxTtl.value })
	}
	return null
})

const effectiveTtl = computed(() => {
	return ttlPreset.value === CUSTOM_TTL ? customTtlSeconds.value : ttlPreset.value
})

const canSubmit = computed(() => {
	const baseOk = bootstrapUrl.value.trim() !== ''
		&& bootstrapUrlError.value === null
		&& customTtlError.value === null
	if (!singleMode.value) {
		return baseOk
	}
	// Single mode needs a parsed seed entry before we can submit
	// `initialEntries`. A failed lookup or in-flight request keeps the
	// button disabled so we never persist a locked room without its
	// one entry.
	return baseOk && lookupResult.value !== null && !lookupPending.value
})

watch(() => props.open, (isOpen) => {
	if (isOpen) {
		name.value = ''
		bootstrapUrl.value = ''
		ttlPreset.value = defaultTtlPreset.value
		customHours.value = Math.min(1, maxCustomHours.value)
		customMinutes.value = 0
		singleMode.value = false
		freeformMode.value = false
		resetSeedState()
	}
})

watch([bootstrapUrl, singleMode], () => {
	scheduleLookup()
})

/**
 * Apply a single-mode change. Mutual exclusion with freeform mode is
 * enforced at the toggle level (`:disabled` on the inactive switch), so
 * this handler only fires when the toggle is reachable. Toggling single
 * mode off clears the seed-entry state so a later flip back doesn't
 * surface a stale lookup result.
 *
 * @param value new switch state from NcCheckboxRadioSwitch
 */
function onSingleModeChange(value: boolean) {
	singleMode.value = value
	if (!value) {
		resetSeedState()
	}
}

/**
 * Apply a freeform-mode change. Same gating story as `onSingleModeChange`.
 *
 * @param value new switch state from NcCheckboxRadioSwitch
 */
function onFreeformModeChange(value: boolean) {
	freeformMode.value = value
}

/**
 * Forward the dialog's open-state change to the parent. Suppresses close
 * attempts while a creation request is in flight so the user cannot dismiss
 * the dialog mid-submission.
 *
 * @param value the new open state requested by NcDialog
 */
function onOpenChange(value: boolean) {
	if (!value && creating.value) {
		return
	}
	emit('update:open', value)
}

/**
 * Validate the form, dispatch the create action through the rooms store, and
 * close the dialog on success. The store itself surfaces any error toast.
 */
async function submit() {
	if (!canSubmit.value || creating.value) {
		return
	}
	const trimmedUrl = bootstrapUrl.value.trim()
	const payload: Parameters<typeof roomsStore.create>[0] = {
		bootstrapUrl: trimmedUrl,
		name: name.value.trim() || null,
		ttl: effectiveTtl.value,
		singleMode: singleMode.value,
		freeformMode: freeformMode.value,
	}
	if (singleMode.value && lookupResult.value !== null) {
		payload.initialEntries = [{
			providerId: lookupResult.value.providerId,
			videoId: lookupResult.value.videoId,
			pageUrl: lookupResult.value.pageUrl,
			label: label.value.trim() || null,
		}]
	}
	const ok = await roomsStore.create(payload)
	if (ok) {
		emit('update:open', false)
	}
}

/**
 * Mark the label field as touched so the next async lookup doesn't
 * stomp on what the owner typed. Fires on every NcTextField update.
 */
function onLabelInput() {
	labelTouched.value = true
}

/**
 * Debounce the URL → metadata lookup so we don't fire on every keystroke.
 * Cleared and re-armed on each input. Single mode is the only path that
 * actually needs the result; the watcher still fires for default-mode
 * URLs but `runLookup` no-ops in that branch.
 */
function scheduleLookup() {
	if (lookupDebounceHandle !== null) {
		clearTimeout(lookupDebounceHandle)
		lookupDebounceHandle = null
	}
	if (!singleMode.value) {
		// Drop any in-flight state when single mode is off so an old
		// preview from a prior single-mode session doesn't linger.
		lookupResult.value = null
		lookupPending.value = false
		seedLookupFailed.value = false
		return
	}
	const value = bootstrapUrl.value.trim()
	if (value === '' || bootstrapUrlError.value !== null) {
		lookupResult.value = null
		lookupPending.value = false
		seedLookupFailed.value = false
		return
	}
	lookupDebounceHandle = setTimeout(() => {
		lookupDebounceHandle = null
		void runLookup(value)
	}, 400)
}

/**
 * Call the metadata endpoint and project its result onto the dialog's
 * state. The `lookupRunId` token discards stale completions when the
 * owner keeps typing while a previous request is in flight.
 *
 * @param value the URL to look up (already trimmed and validated as http(s))
 */
async function runLookup(value: string) {
	const runId = ++lookupRunId
	lookupPending.value = true
	seedLookupFailed.value = false
	const result = await lookupMetadata(value)
	if (runId !== lookupRunId) {
		return
	}
	lookupPending.value = false
	if (result === null) {
		lookupResult.value = null
		seedLookupFailed.value = true
		return
	}
	lookupResult.value = result
	if (!labelTouched.value && result.label !== null) {
		label.value = result.label
	}
}

/**
 * Clear every piece of seed-entry state. Called on dialog open, when
 * single mode is toggled off, and when the bootstrap URL goes empty.
 */
function resetSeedState() {
	if (lookupDebounceHandle !== null) {
		clearTimeout(lookupDebounceHandle)
		lookupDebounceHandle = null
	}
	lookupRunId++
	label.value = ''
	labelTouched.value = false
	lookupPending.value = false
	lookupResult.value = null
	seedLookupFailed.value = false
}

/**
 * Read the server-injected room TTL ceiling from the page's initial state.
 * Falls back to the historical 24-hour default when the value is missing,
 * non-positive, or the initial-state key is not registered (e.g. when the
 * dialog is mounted outside the rooms page during a test).
 *
 * @return the configured maximum room TTL in seconds
 */
function loadInitialMaxTtl(): number {
	try {
		const state = loadState<{ maxTtlSeconds?: unknown }>('playbacksync', 'roomLimits')
		const raw = state?.maxTtlSeconds
		if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
			return Math.floor(raw)
		}
	} catch {
		// loadState throws when the key isn't injected for this page.
	}
	return FALLBACK_MAX_TTL_SECONDS
}

/**
 * Format a TTL ceiling for display in helper and error text. Round hours
 * (1h, 6h, 12h, 24h) and round minutes (≤59m) get their cleaner unit form;
 * everything else falls back to a compact "{h}h {m}m" pattern.
 *
 * @param seconds the duration in seconds, must be positive
 * @return a localized string suitable for substitution into UI copy
 */
function formatTtlLimit(seconds: number): string {
	const hours = Math.floor(seconds / 3600)
	const minutes = Math.floor((seconds % 3600) / 60)
	if (hours > 0 && minutes === 0) {
		return t('playbacksync', '{hours}h', { hours })
	}
	if (hours === 0 && minutes > 0) {
		return t('playbacksync', '{minutes}m', { minutes })
	}
	return t('playbacksync', '{hours}h {minutes}m', { hours, minutes })
}
</script>

<style scoped>
.room-create-form {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 8px 4px;
}

.ttl-custom {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
	align-items: start;
}

.room-create-form__modes {
	display: flex;
	flex-direction: column;
	gap: 4px;
	margin: 0;
	padding: 8px 0 0;
	border: 0;
}

.room-create-form__modes legend {
	font-weight: 600;
	margin-bottom: 4px;
}

.room-create-form__mode-hint {
	margin: 0 0 8px 36px;
	color: var(--color-text-maxcontrast);
	font-size: 0.85rem;
}

.room-create-form__mode-hint--exclusive {
	margin-inline-start: 0;
	font-style: italic;
}

.room-create-form__seed {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 8px 0 0;
}

.room-create-form__seed-status {
	display: flex;
	align-items: center;
	gap: 8px;
	color: var(--color-text-maxcontrast);
	font-size: 0.85rem;
}

.room-create-form__seed-preview {
	display: flex;
	align-items: baseline;
	gap: 8px;
	color: var(--color-main-text);
	font-size: 0.9rem;
}

.room-create-form__seed-preview--missing {
	color: var(--color-text-maxcontrast);
	font-style: italic;
}

.room-create-form__seed-preview--error {
	color: var(--color-error);
}

.room-create-form__seed-chip {
	padding: 1px 6px;
	border-radius: 4px;
	font-size: 0.7rem;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.02em;
	background: var(--color-background-dark);
	color: var(--color-main-text);
}

.room-create-form__seed-title {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
}
</style>
