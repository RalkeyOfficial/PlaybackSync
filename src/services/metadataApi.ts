import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

/**
 * Wire shape of `POST /api/v1/metadata/lookup`. `label` and `providerName`
 * are populated when the oEmbed call succeeded; they're `null` when the
 * URL parsed but the title couldn't be fetched (network failure, unsupported
 * provider, etc) — the dialog can still submit the entry with `label: null`.
 */
export interface MetadataLookupResult {
	providerId: string
	videoId: string
	pageUrl: string
	label: string | null
	providerName: string | null
	thumbnailUrl: string | null
}

/**
 * Resolve a pasted page URL to its `(providerId, videoId, pageUrl)` triple
 * plus best-effort label. Returns `null` on any error so the caller can
 * treat absence of a result uniformly — the dialog falls back to "Title
 * not found, will use URL" and lets the owner type a label by hand.
 *
 * The server returns 400 `unsupported_url` when the input isn't a valid
 * http(s) URL; everything else (parsed URL, no oEmbed match, transport
 * failure on oEmbed call) collapses to HTTP 200 with `label: null`.
 *
 * @param pageUrl the URL the owner pasted into the create dialog
 * @return the resolved metadata, or `null` if the URL couldn't be parsed
 *         or the request itself failed
 */
export async function lookupMetadata(pageUrl: string): Promise<MetadataLookupResult | null> {
	try {
		const { data } = await axios.post<MetadataLookupResult>(
			generateUrl('/apps/playbacksync/api/v1/metadata/lookup'),
			{ pageUrl },
		)
		return data
	} catch {
		return null
	}
}
