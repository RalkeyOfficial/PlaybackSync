<template>
	<NcDialog
		:name="t('playbacksync', 'Personal settings')"
		size="normal"
		:open="open"
		@update:open="onOpenChange">
		<NcSettingsSection
			:name="t('playbacksync', 'Dashboard')"
			:description="t('playbacksync', 'How the rooms dashboard behaves and is displayed while it is open.')">
			<NcTextField
				v-model.number="intervalSeconds"
				type="number"
				:label="t('playbacksync', 'Auto-refresh interval (seconds)')"
				:helperText="t('playbacksync', 'How often the rooms list refreshes automatically.')"
				:min="MIN_INTERVAL_SECONDS"
				:max="MAX_INTERVAL_SECONDS"
				step="1"
				inputmode="numeric" />
			<NcSelect
				v-model="roomsSortOrder"
				:options="sortOrderOptions"
				:inputLabel="t('playbacksync', 'Sort rooms by')"
				:reduce="reduceValue"
				:clearable="false" />
			<NcSelect
				v-model="timestampFormat"
				:options="timestampFormatOptions"
				:inputLabel="t('playbacksync', 'Timestamp format')"
				:reduce="reduceValue"
				:clearable="false" />
		</NcSettingsSection>

		<NcSettingsSection
			:name="t('playbacksync', 'Sharing')"
			:description="t('playbacksync', 'How the Copy actions format room details on your clipboard.')">
			<NcSelect
				v-model="shareCopyFormat"
				:options="shareCopyFormatOptions"
				:inputLabel="t('playbacksync', 'Share copy format')"
				:reduce="reduceValue"
				:clearable="false" />
		</NcSettingsSection>

		<template #actions>
			<NcButton variant="tertiary" :disabled="store.saving" @click="onOpenChange(false)">
				{{ t('playbacksync', 'Cancel') }}
			</NcButton>
			<NcButton
				variant="primary"
				:disabled="!canSave || store.saving"
				@click="save">
				<template #icon>
					<NcLoadingIcon v-if="store.saving" :size="20" />
					<IconContentSave v-else :size="20" />
				</template>
				{{ t('playbacksync', 'Save') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script setup lang="ts">
import type {
	RoomsSortOrder,
	ShareCopyFormat,
	TimestampFormat,
} from '../types/userSettings.ts'

import { translate as t } from '@nextcloud/l10n'
import { computed, ref, watch } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcSettingsSection from '@nextcloud/vue/components/NcSettingsSection'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconContentSave from 'vue-material-design-icons/ContentSave.vue'
import { useUserSettingsStore } from '../stores/userSettings.ts'

interface SelectOption<T extends string> {
	value: T
	label: string
}

const props = defineProps<{
	open: boolean
}>()

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void
}>()

const MIN_INTERVAL_SECONDS = 2
const MAX_INTERVAL_SECONDS = 600

const store = useUserSettingsStore()

// Local edit buffer so Cancel can discard without round-tripping through the
// store. Seeded from the store every time the dialog opens.
const intervalSeconds = ref(toSeconds(store.autoRefreshIntervalMs))
const timestampFormat = ref<TimestampFormat>(store.timestampFormat)
const shareCopyFormat = ref<ShareCopyFormat>(store.shareCopyFormat)
const roomsSortOrder = ref<RoomsSortOrder>(store.roomsSortOrder)

watch(
	() => props.open,
	(isOpen) => {
		if (isOpen) {
			intervalSeconds.value = toSeconds(store.autoRefreshIntervalMs)
			timestampFormat.value = store.timestampFormat
			shareCopyFormat.value = store.shareCopyFormat
			roomsSortOrder.value = store.roomsSortOrder
		}
	},
)

const timestampFormatOptions = computed<SelectOption<TimestampFormat>[]>(() => [
	{ value: 'relative', label: t('playbacksync', 'Relative (5m ago)') },
	{ value: 'absolute', label: t('playbacksync', 'Absolute (date & time)') },
])

const shareCopyFormatOptions = computed<SelectOption<ShareCopyFormat>[]>(() => [
	{ value: 'link', label: t('playbacksync', 'Plain link') },
	{ value: 'markdown', label: t('playbacksync', 'Markdown') },
	{ value: 'discord', label: t('playbacksync', 'Discord') },
])

const sortOrderOptions = computed<SelectOption<RoomsSortOrder>[]>(() => [
	{ value: 'newest', label: t('playbacksync', 'Newest first') },
	{ value: 'oldest', label: t('playbacksync', 'Oldest first') },
	{ value: 'name', label: t('playbacksync', 'Name (A–Z)') },
	{ value: 'expiring', label: t('playbacksync', 'Expiring soonest') },
])

const canSave = computed(() => {
	const value = intervalSeconds.value
	return Number.isFinite(value)
		&& Number.isInteger(value)
		&& value >= MIN_INTERVAL_SECONDS
		&& value <= MAX_INTERVAL_SECONDS
})

/**
 * Pull the primitive value out of an NcSelect option wrapper so v-model
 * binds to the enum string rather than the option object.
 *
 * @param option the option object NcSelect emits
 * @return the underlying enum value
 */
function reduceValue<T extends string>(option: SelectOption<T>): T {
	return option.value
}

/**
 * Persist the edited settings. On success the dialog closes; on failure the
 * store has already surfaced a toast and we keep the dialog open so the user
 * can correct their input.
 */
async function save() {
	if (!canSave.value) {
		return
	}
	const ok = await store.save({
		auto_refresh_interval_ms: intervalSeconds.value * 1000,
		timestamp_format: timestampFormat.value,
		share_copy_format: shareCopyFormat.value,
		rooms_sort_order: roomsSortOrder.value,
	})
	if (ok) {
		emit('update:open', false)
	}
}

/**
 * Forward the dialog's open-state change. Suppresses dismissal while a save
 * is in flight so the user cannot close the dialog mid-request.
 *
 * @param value the new open state requested by NcDialog
 */
function onOpenChange(value: boolean) {
	if (!value && store.saving) {
		return
	}
	emit('update:open', value)
}

/**
 * Convert the store's millisecond value into the seconds the form binds to.
 *
 * @param ms millisecond value from the store
 * @return whole seconds
 */
function toSeconds(ms: number): number {
	return Math.round(ms / 1000)
}
</script>

<style scoped>
/* The dialog body inherits its layout from NcSettingsSection; no extra
 * styling needed today. Keep this block so the SFC carries scoped styles
 * per the project convention. */
</style>
