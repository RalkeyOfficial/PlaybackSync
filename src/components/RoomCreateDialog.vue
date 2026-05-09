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

			<label class="ttl-field">
				<span>{{ t('playbacksync', 'Expires after') }}</span>
				<select v-model="ttl">
					<option
						v-for="option in ttlOptions"
						:key="option.value"
						:value="option.value">
						{{ option.label }}
					</option>
				</select>
			</label>
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

const name = ref('')
const targetUrl = ref('')
const ttl = ref(86400)

const ttlOptions = [
	{ value: 3600, label: t('playbacksync', '1 hour') },
	{ value: 21600, label: t('playbacksync', '6 hours') },
	{ value: 43200, label: t('playbacksync', '12 hours') },
	{ value: 86400, label: t('playbacksync', '24 hours') },
]

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

const canSubmit = computed(() => targetUrl.value.trim() !== '' && targetUrlError.value === null)

watch(() => props.open, (isOpen) => {
	if (isOpen) {
		name.value = ''
		targetUrl.value = ''
		ttl.value = 86400
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
		ttl: ttl.value,
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

.ttl-field {
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: var(--default-font-size, 14px);
}

.ttl-field select {
	min-height: 36px;
}
</style>
