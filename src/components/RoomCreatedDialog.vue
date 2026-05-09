<template>
	<NcDialog
		:name="t('playbacksync', 'Room created')"
		size="normal"
		:open="!!room"
		:canClose="true"
		@update:open="onOpenChange">
		<div v-if="room" class="created-room">
			<NcNoteCard type="warning">
				{{ t('playbacksync', 'Copy the password now. It will not be shown again.') }}
			</NcNoteCard>

			<div class="field">
				<span class="field__label">{{ t('playbacksync', 'Password') }}</span>
				<div class="field__row">
					<code class="field__value field__value--mono">{{ room.password }}</code>
					<NcButton :aria-label="t('playbacksync', 'Copy password')" @click="copy(room.password, 'password')">
						<template #icon>
							<IconCheck v-if="copied === 'password'" :size="20" />
							<IconCopy v-else :size="20" />
						</template>
					</NcButton>
				</div>
			</div>

			<div class="field">
				<span class="field__label">{{ t('playbacksync', 'Share link') }}</span>
				<div class="field__row">
					<code class="field__value">{{ room.shareLink }}</code>
					<NcButton :aria-label="t('playbacksync', 'Copy share link')" @click="copy(room.shareLink, 'link')">
						<template #icon>
							<IconCheck v-if="copied === 'link'" :size="20" />
							<IconCopy v-else :size="20" />
						</template>
					</NcButton>
				</div>
			</div>
		</div>

		<template #actions>
			<NcButton variant="primary" @click="onOpenChange(false)">
				{{ t('playbacksync', 'Done') }}
			</NcButton>
		</template>
	</NcDialog>
</template>

<script setup lang="ts">
import type { CreatedRoom } from '../types/room.ts'

import { showError, showSuccess } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { getLoggerBuilder } from '@nextcloud/logger'
import { ref } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import IconCheck from 'vue-material-design-icons/Check.vue'
import IconCopy from 'vue-material-design-icons/ContentCopy.vue'

const props = defineProps<{
	room: CreatedRoom | null
}>()

const emit = defineEmits<{
	(e: 'dismiss'): void
}>()

const logger = getLoggerBuilder().setApp('playbacksync').detectUser().build()

const copied = ref<'password' | 'link' | null>(null)

/**
 * Copy the password or share link to the clipboard and briefly mark the
 * corresponding button as "copied" so the user gets visual feedback.
 *
 * @param value the string to write to the clipboard
 * @param kind which field is being copied; drives the toast text and the icon swap
 */
async function copy(value: string, kind: 'password' | 'link') {
	try {
		await navigator.clipboard.writeText(value)
		copied.value = kind
		showSuccess(kind === 'password'
			? t('playbacksync', 'Password copied')
			: t('playbacksync', 'Share link copied'))
		setTimeout(() => {
			if (copied.value === kind) {
				copied.value = null
			}
		}, 1500)
	} catch (error) {
		logger.error('Clipboard write failed', { error })
		showError(t('playbacksync', 'Could not copy to clipboard.'))
	}
}

/**
 * Forward the dialog's open-state change to the parent so it can clear `lastCreated`.
 * Only `false` transitions emit `dismiss`; opening is owned by the parent.
 *
 * @param open the new open state from NcDialog
 */
function onOpenChange(open: boolean) {
	if (!open && props.room) {
		emit('dismiss')
	}
}
</script>

<style scoped>
.created-room {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 8px 4px;
}

.field {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.field__label {
	font-weight: bold;
	font-size: var(--default-font-size, 14px);
}

.field__row {
	display: flex;
	align-items: center;
	gap: 8px;
}

.field__value {
	flex: 1;
	padding: 8px 12px;
	background-color: var(--color-background-dark);
	border-radius: var(--border-radius);
	overflow-wrap: anywhere;
	user-select: all;
}

.field__value--mono {
	font-family: var(--font-monospace, monospace);
	letter-spacing: 0.05em;
}
</style>
