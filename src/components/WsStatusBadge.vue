<template>
	<span class="ws-status-badge">
		<StatusBadge :variant="variant" :label="label" :tooltip="tooltip" />
		<NcButton
			v-if="store.isUnavailable"
			variant="tertiary-no-background"
			:aria-label="t('playbacksync', 'Why is sync unavailable?')"
			class="ws-status-badge__help"
			@click="dialogOpen = true">
			<template #icon>
				<IconHelpCircle :size="20" />
			</template>
		</NcButton>

		<NcDialog
			:name="dialogTitle"
			size="normal"
			:open="dialogOpen"
			:canClose="true"
			@update:open="dialogOpen = $event">
			<div class="ws-status-help">
				<template v-if="store.isNotInstalled">
					<p>
						{{ t('playbacksync', 'Until an administrator installs the WebSocket sync service, new rooms cannot be created and existing rooms will not synchronise playback between participants.') }}
					</p>
					<p>
						<a
							:href="INSTALL_DOC_URL"
							target="_blank"
							rel="noopener noreferrer">
							{{ t('playbacksync', 'View installation instructions') }}
							<IconOpenInNew :size="14" />
						</a>
					</p>
				</template>

				<template v-else-if="store.isNotRunning">
					<p>
						{{ t('playbacksync', 'The sync service is installed, but the daemon process is not currently running. Rooms still appear in the list, but joining one will not synchronise playback until the daemon is back up.') }}
					</p>
					<p>
						{{ t('playbacksync', 'An administrator needs to restart the sync daemon using whatever supervises it on this server — systemd, a Docker Compose service, or a manual run. The operator guide has the exact command for each.') }}
					</p>
					<p>
						<a
							:href="OPERATOR_DOC_URL"
							target="_blank"
							rel="noopener noreferrer">
							{{ t('playbacksync', 'View operator guide') }}
							<IconOpenInNew :size="14" />
						</a>
					</p>
				</template>
			</div>
			<template #actions>
				<NcButton variant="primary" @click="dialogOpen = false">
					{{ t('playbacksync', 'Close') }}
				</NcButton>
			</template>
		</NcDialog>
	</span>
</template>

<script setup lang="ts">
import { translate as t } from '@nextcloud/l10n'
import { computed, ref } from 'vue'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import IconHelpCircle from 'vue-material-design-icons/HelpCircle.vue'
import IconOpenInNew from 'vue-material-design-icons/OpenInNew.vue'
import StatusBadge from './StatusBadge.vue'
import { useWsStatusStore } from '../stores/wsStatus.ts'

/**
 * Domain-aware wrapper around StatusBadge: maps the WS status store to a
 * variant + i18n strings, and surfaces a help affordance when the service
 * isn't usable. The dialog content branches on `reason`:
 *   - not_installed → install instructions.
 *   - not_running   → restart hints + link to the operator guide.
 *
 * `not_running` is rendered as `warning`, not `error`: the system is set
 * up correctly, just temporarily down. Distinguishing the two visually
 * matches what the dialog says — a different problem with a different fix.
 */

// Tracks the repo's default branch so URLs stay valid if the branch is
// ever renamed.
const INSTALL_DOC_URL = 'https://github.com/RalkeyOfficial/PlaybackSync/blob/HEAD/docs/install-without-script.md'
const OPERATOR_DOC_URL = 'https://github.com/RalkeyOfficial/PlaybackSync/blob/HEAD/docs/ws-sync-server.md'

const store = useWsStatusStore()
const dialogOpen = ref(false)

const variant = computed<'success' | 'error' | 'warning' | 'pending'>(() => {
	if (!store.loaded) {
		return 'pending'
	}
	if (store.isAvailable) {
		return 'success'
	}
	return store.isNotRunning ? 'warning' : 'error'
})

const label = computed(() => {
	if (!store.loaded) {
		return t('playbacksync', 'Checking sync server…')
	}
	if (store.isAvailable) {
		return t('playbacksync', 'Sync server ready')
	}
	if (store.isNotRunning) {
		return t('playbacksync', 'Sync server not running')
	}
	return t('playbacksync', 'Sync server unavailable')
})

const tooltip = computed(() => {
	if (!store.loaded) {
		return t('playbacksync', 'Checking whether the WebSocket sync service is installed.')
	}
	if (store.isAvailable) {
		return t('playbacksync', 'The WebSocket sync service is installed and configured on this server.')
	}
	if (store.isNotRunning) {
		return t('playbacksync', 'The sync service is installed, but the daemon is not currently running.')
	}
	return t('playbacksync', 'The WebSocket sync service is not installed. Ask an administrator to set it up.')
})

const dialogTitle = computed(() => {
	if (store.isNotRunning) {
		return t('playbacksync', 'Sync server not running')
	}
	return t('playbacksync', 'Sync server not set up')
})

</script>

<style scoped>
.ws-status-badge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

.ws-status-badge__help :deep(.button-vue) {
	/* Compact help affordance — sits next to the badge without dominating. */
	min-height: 28px;
	min-width: 28px;
	padding: 0;
}

.ws-status-help p {
	margin: 0 0 12px 0;
	line-height: 1.5;
}

.ws-status-help p:last-child {
	margin-bottom: 0;
}

.ws-status-help a {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--color-primary-element, #0082c9);
	font-weight: 500;
	text-decoration: underline;
}

.ws-status-help a:hover,
.ws-status-help a:focus-visible {
	text-decoration: none;
}
</style>
