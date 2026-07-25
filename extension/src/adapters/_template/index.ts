import type { ContentIdentity, PageAdapterFactory } from '../types'
import { PageBaseAdapter } from '../base'

/**
 * Baseline **page-role** adapter. Activates only when the URL contains the
 * query parameter `pbsync-template`, so it stays inert on every real site. New
 * page adapters are forked from this file: extend {@link PageBaseAdapter}, match
 * a real host in {@link canHandlePage}, wait for the page to settle in
 * {@link PageBaseAdapter.resolveReady} (if the site mutates the URL after load),
 * and derive identity in {@link resolveIdentity}. Cursor navigation, the command
 * handler, and teardown are inherited.
 *
 * The `<video>` is a separate concern: it belongs to a media-role adapter (see
 * `src/adapters/media/base.ts` and `src/adapters/strmcx/index.ts`). For a site
 * whose player is same-frame, list its host in `embed-matches.ts` and ship a
 * `MediaRole` too; for an embed site, the existing embed media adapter serves it.
 *
 * Optional page hooks a real adapter often adds:
 * {@link PageBaseAdapter.applyCursorChange} +
 * {@link PageBaseAdapter.watchCursorTriggers} (in-page episode navigation),
 * `scrapeCatalog` (episode lists), and `guardNavigation` (identity-bearing
 * URLs). See `docs/adapter-contract.md`.
 */
class TemplatePageAdapter extends PageBaseAdapter {
	readonly id = 'template'

	canHandlePage(url: URL): boolean {
		return url.searchParams.has('pbsync-template')
	}

	protected resolveIdentity(): ContentIdentity | null {
		return {
			providerId: 'template',
			videoId: location.pathname,
			normalizedUrl: location.pathname,
		}
	}
}

export const templatePageAdapterFactory: PageAdapterFactory = () => new TemplatePageAdapter()
