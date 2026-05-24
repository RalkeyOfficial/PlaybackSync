import type {
	AuthoritativeCommand,
	ContentIdentity,
	LocalIntent,
} from './adapters/types'

/**
 * Discriminated union of every message a content script may send the
 * background. Tagged so the background can route without unwrapping into
 * `any`. `adapterId` is included for log correlation — the background
 * does not authenticate it, the content script is trusted.
 */
export type ContentToBackground =
	| { kind: 'intent'; adapterId: string; intent: LocalIntent }
	| { kind: 'identity'; adapterId: string; identity: ContentIdentity }
	| { kind: 'fail'; adapterId: string; reason: string }

/**
 * Background → content. Only `command` exists in this slice. Will grow
 * when the WS client lands (room state, sync events, etc.).
 */
export type BackgroundToContent =
	| { kind: 'command'; command: AuthoritativeCommand }
