import type { AdapterFactory, ContentIdentity } from '../types'
import { BaseAdapter } from '../base'

/**
 * Baseline adapter. Activates only when the URL contains the query parameter
 * `pbsync-template`, so it stays inert on every real site. New site adapters
 * are forked from this file: extend {@link BaseAdapter}, match a real host in
 * {@link canHandlePage}, resolve the player in {@link resolveVideo}, and derive
 * identity in {@link resolveIdentity}. Everything else — state polling, intent
 * wiring, the command switch, teardown — is inherited.
 *
 * Optional hooks a real adapter often adds: {@link BaseAdapter.ensurePlayable}
 * / {@link BaseAdapter.canPlay} (cold-start players), `holdsAutoplay`
 * (auto-playing players), {@link BaseAdapter.applyCursorChange} +
 * {@link BaseAdapter.watchCursorTriggers} (in-page episode navigation),
 * `scrapeCatalog` (episode lists), and `guardNavigation` (identity-bearing
 * URLs). See `docs/adapter-contract.md`.
 */
class TemplateAdapter extends BaseAdapter {
	readonly id = 'template'

	canHandlePage(url: URL): boolean {
		return url.searchParams.has('pbsync-template')
	}

	protected async resolveVideo(): Promise<HTMLVideoElement | null> {
		return document.querySelector<HTMLVideoElement>('video')
	}

	protected resolveIdentity(): ContentIdentity | null {
		return {
			providerId: 'template',
			videoId: location.pathname,
			normalizedUrl: location.pathname,
		}
	}
}

export const templateAdapterFactory: AdapterFactory = () => new TemplateAdapter()
