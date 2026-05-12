<template>
	<NcDialog
		:name="t('playbacksync', 'Personal settings')"
		size="normal"
		:open="open"
		@update:open="onOpenChange">
		<NcSettingsSection
			:name="t('playbacksync', 'Dashboard')"
			:description="t('playbacksync', 'How the rooms dashboard behaves while it is open.')">
			<NcTextField
				v-model.number="intervalSeconds"
				type="number"
				:label="t('playbacksync', 'Auto-refresh interval (seconds)')"
				:helperText="t('playbacksync', 'How often the rooms list refreshes automatically.')"
				:min="MIN_INTERVAL_SECONDS"
				:max="MAX_INTERVAL_SECONDS"
				step="1"
				inputmode="numeric" />
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
import { translate as t } from '@nextcloud/l10n'
import { computed, ref, watch } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcLoadingIcon from '@nextcloud/vue/components/NcLoadingIcon'
import NcSettingsSection from '@nextcloud/vue/components/NcSettingsSection'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconContentSave from 'vue-material-design-icons/ContentSave.vue'
import { useUserSettingsStore } from '../stores/userSettings.ts'

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

watch(
	() => props.open,
	(isOpen) => {
		if (isOpen) {
			intervalSeconds.value = toSeconds(store.autoRefreshIntervalMs)
		}
	},
)

const canSave = computed(() => {
	const value = intervalSeconds.value
	return Number.isFinite(value)
		&& Number.isInteger(value)
		&& value >= MIN_INTERVAL_SECONDS
		&& value <= MAX_INTERVAL_SECONDS
})

/**
 * Persist the edited interval. On success the dialog closes; on failure the
 * store has already surfaced a toast and we keep the dialog open so the user
 * can correct their input.
 */
async function save() {
	if (!canSave.value) {
		return
	}
	const ok = await store.save({ auto_refresh_interval_ms: intervalSeconds.value * 1000 })
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
