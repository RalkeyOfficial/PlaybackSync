/**
 * Best-effort `(providerId, videoId, pageUrl)` extractor for the dashboard
 * "add entry" form. Recognises YouTube, Vimeo, and Crunchyroll URL shapes;
 * everything else falls back to `providerId: 'generic'` with the URL's
 * last path segment as the videoId.
 *
 * The natural key on the backend is `(providerId, videoId)` — what matters
 * most is that two URLs to the same video produce the same key. Browser
 * extensions on a real watch page report the provider's true id; this
 * parser is only the dashboard's curated-entry fallback.
 */
export interface ParsedVideo {
	providerId: string
	videoId: string
	pageUrl: string
}

/**
 * Parse a video URL into the wire shape the playlist endpoints expect.
 * Returns `null` when the input isn't a usable http(s) URL.
 *
 * @param rawUrl the URL string from the user
 * @return the parsed entry or `null` if the URL was unusable
 */
export function parseVideoUrl(rawUrl: string): ParsedVideo | null {
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

	if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
		const v = url.searchParams.get('v')
		if (v) {
			return { providerId: 'youtube', videoId: v, pageUrl: trimmed }
		}
	}
	if (host === 'youtu.be') {
		const id = url.pathname.replace(/^\/+/, '').split('/')[0]
		if (id) {
			return { providerId: 'youtube', videoId: id, pageUrl: trimmed }
		}
	}
	if (host === 'vimeo.com' || host === 'player.vimeo.com') {
		const segments = url.pathname.split('/').filter((s) => s !== '')
		const last = segments[segments.length - 1]
		if (last && /^\d+$/.test(last)) {
			return { providerId: 'vimeo', videoId: last, pageUrl: trimmed }
		}
	}
	if (host.endsWith('crunchyroll.com')) {
		// Pattern: /watch/{id}/{slug?} — capture the id after /watch/.
		const match = url.pathname.match(/\/watch\/([^/]+)/)
		if (match) {
			return { providerId: 'crunchyroll', videoId: match[1], pageUrl: trimmed }
		}
	}

	const segments = url.pathname.split('/').filter((s) => s !== '')
	const fallbackId = segments.length > 0 ? segments[segments.length - 1] : host
	return { providerId: 'generic', videoId: fallbackId, pageUrl: trimmed }
}

/**
 * Parse a textarea full of URLs (one per line) into a list of parsed
 * entries plus a list of lines that couldn't be parsed (so the caller
 * can surface them to the user).
 *
 * @param raw the textarea contents
 * @return the parsed entries and the offending raw lines, in input order
 */
export function parseVideoUrlList(raw: string): { entries: ParsedVideo[], invalidLines: string[] } {
	const entries: ParsedVideo[] = []
	const invalidLines: string[] = []
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (trimmed === '') {
			continue
		}
		const parsed = parseVideoUrl(trimmed)
		if (parsed === null) {
			invalidLines.push(trimmed)
			continue
		}
		entries.push(parsed)
	}
	return { entries, invalidLines }
}
