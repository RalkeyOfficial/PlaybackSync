import type { MediaAdapterFactory, MediaRole } from '../types'
import { strmcxAdapterFactory } from '../strmcx'

/**
 * Static registry of bundled **media-role** adapters (the embed-frame half —
 * the `<video>` owners). Selected by {@link MediaRole.canHandleFrame} against
 * the frame's own URL; first match wins. A media adapter carries no
 * site-identity knowledge, so one entry (e.g. `strmcx`) serves every page site
 * embedding that player. Adding a new embedded player = appending its factory
 * here **and** listing its host in `src/adapters/embed-matches.ts`.
 */
const MEDIA_ADAPTERS: MediaAdapterFactory[] = [
	strmcxAdapterFactory,
]

/**
 * Pick the first media adapter that claims this frame, or `null` when none
 * does (a matched host that isn't actually a player frame).
 *
 * @param url The frame's own URL.
 * @returns A fresh media adapter instance, or `null`.
 */
export function selectMediaAdapter(url: URL): MediaRole | null {
	for (const factory of MEDIA_ADAPTERS) {
		const candidate = factory()
		if (candidate.canHandleFrame(url)) return candidate
	}
	return null
}
