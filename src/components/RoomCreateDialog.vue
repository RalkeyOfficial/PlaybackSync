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
					:helperText="customTtlError ?? t('playbacksync', 'Between 1 minute and 24 hours.')"
					min="0"
					max="24"
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
const MAX_TTL_SECONDS = 86400

const name = ref('')
const targetUrl = ref('')
const ttlPreset = ref(86400)
const customHours = ref(1)
const customMinutes = ref(0)

interface TtlOption {
	value: number
	label: string
}

const ttlOptions: TtlOption[] = [
	{ value: 3600, label: t('playbacksync', '1 hour') },
	{ value: 21600, label: t('playbacksync', '6 hours') },
	{ value: 43200, label: t('playbacksync', '12 hours') },
	{ value: 86400, label: t('playbacksync', '24 hours') },
	{ value: CUSTOM_TTL, label: t('playbacksync', 'Custom…') },
]

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
		return t('playbacksync', 'Must be 24 hours or less.')
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
		ttlPreset.value = 86400
		customHours.value = 1
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
