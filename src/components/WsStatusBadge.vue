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
						{{ t('playbacksync', 'An administrator can restart the daemon with the following command on the Nextcloud host:') }}
					</p>
					<pre class="ws-status-help__cmd">sudo systemctl restart playbacksync-ws.service</pre>
					<p>
						<!-- The translation contains a `{cmd}` placeholder so translators
							can position the inline code element wherever the target
							language's word order needs it, instead of being locked
							into the English split. -->
						<template v-for="(segment, i) in manualCmdSegments" :key="i">
							<code v-if="segment.kind === 'cmd'" class="ws-status-help__inline-cmd">{{ segment.text }}</code>
							<template v-else>{{ segment.text }}</template>
						</template>
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

interface CmdSegment {
	kind: 'text' | 'cmd'
	text: string
}

/**
 * Split a translated string carrying a `{cmd}` placeholder into renderable
 * segments. Returns alternating `text`/`cmd` parts so the template can wrap
 * just the cmd in a `<code>` element while keeping the surrounding words as
 * plain text. The placeholder position is the translator's choice — works
 * for any word order, including languages where the command lands at the
 * start or end of the sentence.
 *
 * @param key the source-English translation key, must contain `{cmd}`
 * @param cmd the literal command to render in place of the placeholder
 * @return alternating text/cmd segments in display order
 */
function tWithCmd(key: string, cmd: string): CmdSegment[] {
	// Sentinel any reasonable translation will never contain. Using a
	// private-use-area code point keeps it out of normal text and out of
	// HTML-significant ranges.
	const sentinel = ''
	const rendered = t('playbacksync', key, { cmd: sentinel })
	const parts = rendered.split(sentinel)
	if (parts.length < 2) {
		// Translator omitted the placeholder. Fall back to appending the
		// command at the end so the UI still tells the operator what to run.
		return [
			{ kind: 'text', text: rendered },
			{ kind: 'cmd', text: cmd },
		]
	}
	const segments: CmdSegment[] = [{ kind: 'text', text: parts[0] }]
	for (let i = 1; i < parts.length; i++) {
		segments.push({ kind: 'cmd', text: cmd })
		segments.push({ kind: 'text', text: parts[i] })
	}
	return segments
}

const manualCmdSegments = computed<CmdSegment[]>(() => tWithCmd('If the service is run manually instead of under systemd, run {cmd} again.', 'occ playbacksync:ws-serve'))
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

.ws-status-help__cmd {
	margin: 0 0 12px 0;
	padding: 8px 12px;
	border-radius: 6px;
	background-color: var(--color-background-dark, #ededed);
	font-family: var(--font-face-mono, monospace);
	font-size: 12px;
	overflow-x: auto;
}

.ws-status-help__inline-cmd {
	padding: 1px 6px;
	border-radius: 4px;
	background-color: var(--color-background-dark, #ededed);
	font-family: var(--font-face-mono, monospace);
	font-size: 0.9em;
}
</style>
