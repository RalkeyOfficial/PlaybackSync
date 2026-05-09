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
				<code class="field__value field__value--mono">{{ room.password }}</code>
			</div>

			<div class="field">
				<span class="field__label">{{ t('playbacksync', 'Share link') }}</span>
				<code class="field__value">{{ room.shareLink }}</code>
			</div>
		</div>

		<template #actions>
			<NcButton @click="copyForDiscord">
				<template #icon>
					<IconCheck v-if="copied" :size="20" />
					<IconCopy v-else :size="20" />
				</template>
				{{ t('playbacksync', 'Copy for Discord') }}
			</NcButton>
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

const copied = ref(false)

/**
 * Copy a Discord-friendly block containing the share link and password to the
 * clipboard. The link is wrapped in `<…>` to suppress Discord's link preview,
 * and the password is fenced as inline code so it is easy to select.
 */
async function copyForDiscord() {
	if (!props.room) {
		return
	}
	const text = `**PlaybackSync Room**\n🔗 <${props.room.shareLink}>\n🔑 \`${props.room.password}\``
	try {
		await navigator.clipboard.writeText(text)
		copied.value = true
		showSuccess(t('playbacksync', 'Room details copied'))
		setTimeout(() => {
			copied.value = false
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
