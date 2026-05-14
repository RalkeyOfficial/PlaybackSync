<template>
	<NcDialog
		:name="t('playbacksync', 'Add to playlist')"
		size="normal"
		:open="open"
		:canClose="!submitting"
		@update:open="onOpenChange">
		<div class="playlist-add">
			<NcSelect
				v-model="mode"
				:options="modeOptions"
				:inputLabel="t('playbacksync', 'Input')"
				:reduce="reduceModeOption"
				:clearable="false" />

			<form v-if="mode === 'one'" class="playlist-add__form" @submit.prevent="submitOne">
				<NcTextField
					v-model="singleUrl"
					type="url"
					:label="t('playbacksync', 'Video URL')"
					placeholder="https://www.youtube.com/watch?v=..."
					:error="!!singleUrlError"
					:helperText="singleUrlError ?? singleParsedHint"
					required />
				<NcTextField
					v-model="singleLabel"
					:label="t('playbacksync', 'Label (optional)')"
					:maxlength="200" />
				<div class="playlist-add__row">
					<NcTextField
						v-model.number="singleSeason"
						type="number"
						:label="t('playbacksync', 'Season (optional)')"
						min="0"
						step="1"
						inputmode="numeric" />
					<NcTextField
						v-model.number="singleEpisode"
						type="number"
						:label="t('playbacksync', 'Episode (optional)')"
						min="0"
						step="1"
						inputmode="numeric" />
				</div>
			</form>

			<form v-else class="playlist-add__form" @submit.prevent="submitMany">
				<label class="playlist-add__textarea-label" for="playlist-add-many-urls">
					{{ t('playbacksync', 'One URL per line') }}
				</label>
				<textarea
					id="playlist-add-many-urls"
					v-model="manyUrls"
					rows="8"
					class="playlist-add__textarea"
					placeholder="https://www.youtube.com/watch?v=..." />
				<p class="playlist-add__counter">
					{{ t('playbacksync', '{n} valid · {invalid} unparseable', { n: manyParsed.entries.length, invalid: manyParsed.invalidLines.length }) }}
				</p>
				<NcNoteCard v-if="manyParsed.invalidLines.length > 0" type="warning">
					{{ t('playbacksync', 'These lines will be skipped:') }}
					<ul class="playlist-add__invalid-list">
						<li v-for="(line, idx) in manyParsed.invalidLines.slice(0, 5)" :key="idx">
							<code>{{ line }}</code>
						</li>
						<li v-if="manyParsed.invalidLines.length > 5">
							{{ t('playbacksync', '… and {n} more', { n: manyParsed.invalidLines.length - 5 }) }}
						</li>
					</ul>
				</NcNoteCard>
			</form>
		</div>

		<template #actions>
			<NcButton variant="tertiary" :disabled="submitting" @click="onOpenChange(false)">
				{{ t('playbacksync', 'Cancel') }}
			</NcButton>
			<NcButton
				v-if="mode === 'one'"
				variant="primary"
				:disabled="!canSubmitOne || submitting"
				@click="submitOne">
				<template #icon>
					<NcLoadingIcon v-if="submitting" :size="20" />
					<IconPlus v-else :size="20" />
				</template>
				{{ t('playbacksync', 'Add entry') }}
			</NcButton>
			<NcButton
				v-else
				variant="primary"
				:disabled="!canSubmitMany || submitting"
				@click="submitMany">
				<template #icon>
					<NcLoadingIcon v-if="submitting" :size="20" />
					<IconPlus v-else :size="20" />
				</template>
				{{ t('playbacksync', 'Add {n} entries', { n: manyParsed.entries.length }) }}
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
import NcNoteCard from '@nextcloud/vue/components/NcNoteCard'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import NcTextField from '@nextcloud/vue/components/NcTextField'
import IconPlus from 'vue-material-design-icons/Plus.vue'
import { useRoomsStore } from '../stores/rooms.ts'
import { parseVideoUrl, parseVideoUrlList } from '../util/parseVideoUrl.ts'

const props = defineProps<{
	open: boolean
	roomUuid: string
}>()

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void
}>()

const roomsStore = useRoomsStore()

type Mode = 'one' | 'many'

interface ModeOption {
	value: Mode
	label: string
}

const modeOptions: ModeOption[] = [
	{ value: 'one', label: t('playbacksync', 'One entry') },
	{ value: 'many', label: t('playbacksync', 'Many entries') },
]

const mode = ref<Mode>('one')
const singleUrl = ref('')
const singleLabel = ref('')
const singleEpisode = ref<number | null>(null)
const singleSeason = ref<number | null>(null)
const manyUrls = ref('')
const submitting = ref(false)

const singleUrlError = computed<string | null>(() => {
	if (singleUrl.value.trim() === '') {
		return null
	}
	if (parseVideoUrl(singleUrl.value) === null) {
		return t('playbacksync', 'Must be a valid http(s) URL.')
	}
	return null
})

const singleParsedHint = computed<string>(() => {
	if (singleUrl.value.trim() === '') {
		return t('playbacksync', 'YouTube, Vimeo, Crunchyroll, or any direct page URL.')
	}
	const parsed = parseVideoUrl(singleUrl.value)
	if (parsed === null) {
		return ''
	}
	return t('playbacksync', 'Recognised as {provider} · {videoId}', { provider: parsed.providerId, videoId: parsed.videoId })
})

const canSubmitOne = computed(() => singleUrl.value.trim() !== '' && singleUrlError.value === null)

const manyParsed = computed(() => parseVideoUrlList(manyUrls.value))

const canSubmitMany = computed(() => manyParsed.value.entries.length > 0)

watch(() => props.open, (isOpen) => {
	if (isOpen) {
		mode.value = 'one'
		singleUrl.value = ''
		singleLabel.value = ''
		singleEpisode.value = null
		singleSeason.value = null
		manyUrls.value = ''
		submitting.value = false
	}
})

/**
 * Extract the value from an NcSelect option so the v-model holds the
 * primitive mode key.
 *
 * @param option the option object emitted by NcSelect
 * @return the mode value
 */
function reduceModeOption(option: ModeOption): Mode {
	return option.value
}

/**
 * Forward the dialog's open-state change to the parent. Suppresses close
 * attempts while submission is in flight.
 *
 * @param value the new open state requested by NcDialog
 */
function onOpenChange(value: boolean) {
	if (!value && submitting.value) {
		return
	}
	emit('update:open', value)
}

/**
 *
 */
async function submitOne() {
	if (!canSubmitOne.value || submitting.value) {
		return
	}
	const parsed = parseVideoUrl(singleUrl.value)
	if (parsed === null) {
		return
	}
	submitting.value = true
	try {
		const ok = await roomsStore.addPlaylistEntry(props.roomUuid, {
			providerId: parsed.providerId,
			videoId: parsed.videoId,
			pageUrl: parsed.pageUrl,
			label: singleLabel.value.trim() || null,
			episodeNumber: Number.isFinite(singleEpisode.value as number) ? singleEpisode.value : null,
			seasonNumber: Number.isFinite(singleSeason.value as number) ? singleSeason.value : null,
		})
		if (ok) {
			emit('update:open', false)
		}
	} finally {
		submitting.value = false
	}
}

/**
 *
 */
async function submitMany() {
	if (!canSubmitMany.value || submitting.value) {
		return
	}
	submitting.value = true
	try {
		// Sequential so the natural-key dedupe order is stable and the
		// per-room cap surfaces on the first overflowing entry rather than
		// crashing the whole batch.
		let added = 0
		for (const entry of manyParsed.value.entries) {
			const ok = await roomsStore.addPlaylistEntry(props.roomUuid, {
				providerId: entry.providerId,
				videoId: entry.videoId,
				pageUrl: entry.pageUrl,
			})
			if (!ok) {
				break
			}
			added++
		}
		if (added > 0) {
			emit('update:open', false)
		}
	} finally {
		submitting.value = false
	}
}
</script>

<style scoped>
.playlist-add {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 8px 4px;
}

.playlist-add__form {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.playlist-add__row {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
}

.playlist-add__textarea-label {
	font-weight: 600;
	font-size: 0.9rem;
}

.playlist-add__textarea {
	width: 100%;
	min-height: 160px;
	padding: 8px 10px;
	border-radius: var(--border-radius);
	border: 1px solid var(--color-border);
	background: var(--color-main-background);
	color: var(--color-main-text);
	font-family: var(--font-face-monospace, monospace);
	font-size: 0.9rem;
	resize: vertical;
}

.playlist-add__counter {
	margin: 0;
	color: var(--color-text-maxcontrast);
	font-size: 0.85rem;
}

.playlist-add__invalid-list {
	margin: 4px 0 0;
	padding-left: 20px;
}
</style>
