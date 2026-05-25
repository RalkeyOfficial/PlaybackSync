import type {
	AuthoritativeCommand,
	ContentIdentity,
	LocalIntent,
	VideoState,
} from './adapters/types'
import type { CursorRef, VideoRefWithMeta } from './background/protocol'

/**
 * Discriminated union of every message a content script may send the
 * background. Tagged so the background can route without unwrapping into
 * `any`. `adapterId` is included on adapter-runtime arms for log
 * correlation — the background does not authenticate it, the content
 * script is trusted.
 *
 * `status` is the periodic state heartbeat the runtime emits while an
 * adapter is active (every ~1 s). The background caches the latest
 * status per tab so its 5 s `HEARTBEAT` wire frames have fresh
 * `currentPos`/`playerState` without an extra round-trip.
 *
 * `credentials` is a one-shot bootstrap message emitted by the dedicated
 * `credentials.content.ts` entrypoint when the page URL carries
 * `?sync_url=…&sync_password=…` (the share-link redirect target produced
 * by `ShareController::buildRedirectUrl` on the PHP side). It is *not*
 * adapter-scoped — credential pickup is browser-runtime-global, fires
 * before any adapter has had a chance to match, and may arrive on a page
 * no adapter ever activates on. The background is first-write-wins:
 * ignored when `pbsync` storage is already populated.
 */
export type ContentToBackground =
	| { kind: 'intent'; adapterId: string; intent: LocalIntent }
	| {
		kind: 'identity'
		adapterId: string
		identity: ContentIdentity
		/**
		 * Full page URL (`location.href`) captured at the moment the
		 * adapter reported identity. The wire-format `JOIN.currentlyShowing`
		 * field requires an origin-qualified URL, but
		 * `ContentIdentity.normalizedUrl` is intentionally hostname-stripped
		 * for identity comparison and can't be reused as-is. The content
		 * entrypoint attaches `pageUrl` here so the background can build a
		 * `VideoRef` without knowing the page's location.
		 */
		pageUrl: string
	}
	| { kind: 'status'; adapterId: string; state: VideoState }
	| { kind: 'fail'; adapterId: string; reason: string }
	| {
		kind: 'catalog'
		adapterId: string
		/**
		 * Result of {@link Adapter.scrapeCatalog} for the currently active
		 * adapter, or `null` when the adapter omits the method, throws, or
		 * the runtime's scrape timeout elapses. The background uses this
		 * (alongside the most recent `identity`) to populate the JOIN
		 * frame's `catalogFragment` once per session.
		 */
		catalog: VideoRefWithMeta[] | null
	}
	| { kind: 'credentials'; syncUrl: string; syncPassword: string }

/**
 * Background → content. Carries authoritative commands the active
 * adapter must apply verbatim. Will grow as the WS client surfaces more
 * server-driven concerns (e.g. room-state hydration for the popup).
 */
export type BackgroundToContent =
	| { kind: 'command'; command: AuthoritativeCommand }

/**
 * Derived connection state surfaced to the toolbar popup. The popup
 * never reads raw socket / `clientId` / creds fields; the background
 * collapses the triple `(creds, socket, clientId)` into a single tag
 * and ships that. Keeps the popup logic trivial and centralises the
 * derivation rule in {@link ./background/popupBroadcast.getDerivedStatus}.
 *
 * - `no_credentials` — no creds in `chrome.storage.local.pbsync`. The
 *   user has not yet followed a share link.
 * - `connecting` — creds present and a socket is open or opening, but
 *   the server has not yet returned a `ROOM_STATE` (so `clientId` is
 *   still `null`).
 * - `joined` — `ROOM_STATE` applied; `clientId` is set; the room is
 *   driving playback.
 * - `disconnected` — creds present but the WS runtime is torn down
 *   (reconnect-pending or terminal). Reconnect-pending shows the same
 *   tag because to the user "we're not connected right now" is the
 *   load-bearing distinction.
 */
export type PopupStatus =
	| 'no_credentials'
	| 'connecting'
	| 'joined'
	| 'disconnected'

/**
 * Snapshot of room state shaped for the toolbar popup. The background
 * computes one of these every time a popup-visible field changes (see
 * `BackgroundToPopup`).
 *
 * `syncPassword` is deliberately **never** included — only `syncUrl`
 * crosses the popup boundary, even though they live in the same
 * process. Making the omission structural means a future copy-to-
 * clipboard or share-this-snapshot affordance cannot leak the password
 * by accident.
 */
export interface PopupSnapshot {
	/**
	 * The tab this snapshot describes. `null` only when the popup
	 * subscribed for a tab that has no per-tab creds slot yet (the
	 * snapshot is the empty `no_credentials` placeholder).
	 */
	tabId: number | null
	/** Derived connection state. */
	status: PopupStatus
	/** Server-assigned client id, or `null` before the first `ROOM_STATE`. */
	clientId: string | null
	/** Current cursor entry, or `null` for an empty playlist / pre-JOIN. */
	cursor: CursorRef | null
	/** Room playback mode; `null` before the first `ROOM_STATE`. */
	mode: 'default' | 'single' | 'freeform' | null
	/**
	 * The WebSocket URL the popup is connected through. Shown in the
	 * "connecting to …" copy. `null` only when `status` is
	 * `no_credentials`.
	 */
	syncUrl: string | null
}

/**
 * Popup → background. The popup opens a long-lived
 * `chrome.runtime.Port` named `'pbsync-popup'` and posts these
 * envelopes over it.
 *
 * - `subscribe` — first envelope after `connect()`. Names the tab the
 *   popup is interested in (derived via
 *   `chrome.tabs.query({active: true, currentWindow: true})`). The
 *   background binds the port to that tab; subsequent snapshots
 *   delivered over the port describe only that tab.
 * - `leave_room` — wipe the named tab's stored creds and tear down its
 *   WS socket. The background broadcasts a fresh `no_credentials`
 *   snapshot for that tab afterwards; the popup re-renders to the
 *   no-creds view without closing.
 */
export type PopupToBackground =
	| { kind: 'subscribe'; tabId: number }
	| { kind: 'leave_room'; tabId: number }

/**
 * Background → popup. Pushed over the same `'pbsync-popup'` port the
 * popup opened. The background emits one snapshot on port connect,
 * then again on every popup-visible state change: `connecting`,
 * socket `open`, `ROOM_STATE` applied, `CURSOR_CHANGE` applied,
 * socket `close` (including reconnect-pending), and `clearCreds()`.
 *
 * `STATE` frames and `PLAYLIST_UPDATE` frames intentionally do **not**
 * trigger a snapshot — `STATE` fires ~1 Hz and only mutates
 * `lastEventId`, which the popup doesn't display, and there is no
 * playlist UI in this slice.
 */
export type BackgroundToPopup =
	| { kind: 'snapshot'; snapshot: PopupSnapshot }
