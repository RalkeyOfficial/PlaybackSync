import type {
	AuthoritativeCommand,
	ContentIdentity,
	LocalIntent,
	VideoState,
} from './adapters/types'

/**
 * Discriminated union of every message a content script may send the
 * background. Tagged so the background can route without unwrapping into
 * `any`. `adapterId` is included for log correlation — the background
 * does not authenticate it, the content script is trusted.
 *
 * `status` is the periodic state heartbeat the runtime emits while an
 * adapter is active (every ~1 s). The background caches the latest
 * status per tab so its 5 s `HEARTBEAT` wire frames have fresh
 * `currentPos`/`playerState` without an extra round-trip.
 */
export type ContentToBackground =
	| { kind: 'intent'; adapterId: string; intent: LocalIntent }
	| { kind: 'identity'; adapterId: string; identity: ContentIdentity }
	| { kind: 'status'; adapterId: string; state: VideoState }
	| { kind: 'fail'; adapterId: string; reason: string }

/**
 * Background → content. Carries authoritative commands the active
 * adapter must apply verbatim. Will grow as the WS client surfaces more
 * server-driven concerns (e.g. room-state hydration for the popup).
 */
export type BackgroundToContent =
	| { kind: 'command'; command: AuthoritativeCommand }
