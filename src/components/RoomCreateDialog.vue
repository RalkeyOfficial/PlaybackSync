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
				v-model="targetUrl"
				type="url"
				:label="t('playbacksync', 'Target video URL')"
				placeholder="https://example.com/watch/..."
				:error="!!targetUrlError"
				:helperText="targetUrlError ?? t('playbacksync', 'The page participants will be redirected to.')"
				required />

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
import { loadState } from '@nextcloud/initial-state'
import { translate as t } from '@nextcloud/l10n'
import { computed, ref, watch } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconPlus from 'vue-material-design-icons/Plus.vue'
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
const targetUrl = ref('')
const customHours = ref(1)
const customMinutes = ref(0)

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

const targetUrlError = computed<string | null>(() => {
	const value = targetUrl.value.trim()
	if (value === '') {
		return null
	}
	if (!/^https?:\/\/\S+/i.test(value)) {
		return t('playbacksync', 'Must be a valid http(s) URL.')
	}
	return null
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
	return targetUrl.value.trim() !== ''
		&& targetUrlError.value === null
		&& customTtlError.value === null
})

watch(() => props.open, (isOpen) => {
	if (isOpen) {
		name.value = ''
		targetUrl.value = ''
		ttlPreset.value = defaultTtlPreset.value
		customHours.value = Math.min(1, maxCustomHours.value)
		customMinutes.value = 0
	}
})

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
	const ok = await roomsStore.create({
		targetUrl: targetUrl.value.trim(),
		name: name.value.trim() || null,
		ttl: effectiveTtl.value,
	})
	if (ok) {
		emit('update:open', false)
	}
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
</style>
