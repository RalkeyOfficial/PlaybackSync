/**
 * Best-effort playlist-mode suggestion for a room's bootstrap URL.
 *
 * At room-creation time the dashboard can only judge a URL by its *shape* — the
 * browser extension's catalog detection (episode lists, playlist sidebars) is not
 * reachable here. So a standalone video (a lone YouTube/Vimeo watch URL) leans
 * `'freeform'` ("movie night"), while a URL that already implies a list or catalog
 * (a YouTube `?list=`, an anime/Crunchyroll watch page) is happy on the `'default'`
 * planned-playlist behaviour.
 *
 * The caller decides what to surface — the modal only nudges toward `'freeform'`,
 * treating `'default'` as "no nudge needed". The full classification is returned anyway
 * so the function stays a pure, testable URL → mode mapping.
 */
export type ModeSuggestion = 'default' | 'freeform'

/**
 * Classify a bootstrap URL into the playlist mode that best fits it.
 *
 * @param rawUrl the bootstrap URL string from the room-creation form
 * @return the suggested mode, or `null` when the host is unknown or the URL is unusable
 */
export function suggestMode(rawUrl: string): ModeSuggestion | null {
	const trimmed = rawUrl.trim()
	if (trimmed === '') {
		return null
	}
	let url: URL
	try {
		url = new URL(trimmed)
	} catch {
		return null
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return null
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, '')

	if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtu.be') {
		// A `list=` param means the URL already carries a playlist — leave the room on
		// its default planned behaviour. A bare watch URL is a standalone clip.
		return url.searchParams.has('list') ? 'default' : 'freeform'
	}
	if (host === 'vimeo.com' || host === 'player.vimeo.com') {
		return 'freeform'
	}
	// Anime/episode catalogs: a single watch URL still belongs to a series, so the
	// planned playlist (default) is the right fit.
	if (host === 'miruro.tv' || host === 'miruro.to' || host === 'miruro.bz' || host === 'miruro.ru') {
		return 'default'
	}
	if (host === 'crunchyroll.com' || host.endsWith('.crunchyroll.com')) {
		return 'default'
	}

	return null
}
