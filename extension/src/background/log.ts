/**
 * Background logging — one formatter so a session's console output reads as a
 * greppable "story" you can scan and paste straight into a bug report.
 *
 * Every line is a coloured `playbacksync:<scope>` badge + `<event>` followed by
 * a structured data object. Filter the DevTools console by:
 * - `playbacksync:` — everything from the extension background
 * - `playbacksync:ws` — connection lifecycle + wire frames in/out
 * - `playbacksync:bg` — intent gating, command dispatch, creds, worker lifecycle
 * - `playbacksync:nav` — navigation-guard + cursor-change routing + reconcile
 * - `playbacksync:sync` — clock sync + heartbeat (all `debug`)
 *
 * ## Levels map onto DevTools' native level filter
 *
 * Each level uses the matching `console` method, so the console's level
 * dropdown (Verbose / Info / Warnings / Errors) *is* the verbosity control —
 * no rebuild, no runtime flag:
 * - `debug` → `console.debug` → shown only when **Verbose** is enabled (off by
 *   default). This is where the high-frequency ticks (heartbeat, clock,
 *   per-URL nav decisions, received intents) live.
 * - `info` → `console.log` → the meaningful session story: connections, joins,
 *   seeks/plays/pauses in and out, cursor changes, nav outcomes, dropped intents.
 * - `warn` → `console.warn`, `error` → `console.error`.
 *
 * The debug lines are always emitted, so DevTools has already captured them —
 * flipping on Verbose reveals the history retroactively.
 *
 * `error` is reserved for genuine extension malfunctions. Expected connectivity
 * outcomes (backend down, reconnect exhausted, protocol close) log at `warn` or
 * below so Chrome's extensions page doesn't flag the extension as broken.
 */

/** Log category, surfaced as the coloured `playbacksync:<scope>` badge. */
export type LogScope = 'bg' | 'ws' | 'nav' | 'sync'

/** Severity; each maps to the matching `console` method (see module doc). */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** Badge background colour per scope, so a scope is recognisable at a glance. */
const SCOPE_BG: Record<LogScope, string> = {
	bg: '#6c5ce7', // purple — core (matches the boot banner)
	ws: '#0984e3', // blue — connection + wire frames
	nav: '#00b894', // green — navigation / cursor routing
	sync: '#636e72', // grey — clock + heartbeat (mostly debug)
}

/**
 * Emit one structured background log line via the `console` method matching
 * `level`, so DevTools' native level filter controls visibility. The scope
 * renders as a coloured `%c` badge; copying the line out of DevTools drops the
 * CSS and yields the plain `playbacksync:<scope> <event> {…}` text.
 *
 * @param scope Category shown as the coloured `playbacksync:<scope>` badge.
 * @param level Severity; `debug` lands under the console's Verbose level.
 * @param event Short, greppable description of what happened.
 * @param data Optional structured fields (ids, positions, reasons).
 */
export function log(scope: LogScope, level: LogLevel, event: string, data?: Record<string, unknown>): void {
	// `%s` carries `event` as an argument (not interpolated into the format
	// string), so a stray `%` in an event label can't break formatting.
	const label = `%cplaybacksync:${scope}%c %s`
	const badgeCss = `background:${SCOPE_BG[scope]};color:#fff;font-weight:bold;padding:2px 5px;border-radius:3px`
	const rest = data === undefined ? [] : [data]
	if (level === 'error') console.error(label, badgeCss, '', event, ...rest)
	else if (level === 'warn') console.warn(label, badgeCss, '', event, ...rest)
	else if (level === 'debug') console.debug(label, badgeCss, '', event, ...rest)
	else console.log(label, badgeCss, '', event, ...rest)
}

/**
 * Print an attention-grabbing one-off banner at worker boot, telling whoever
 * opens the service-worker console that detailed logs are one click away behind
 * the Verbose level filter. Styled so it stands out from the log stream.
 */
export function logStartupBanner(): void {
	console.log(
		'%c ▶ PlaybackSync %c debug logs available — set the console level filter to “Verbose” to start seeing them %c',
		'background:#e84393;color:#fff;font-weight:bold;font-size:15px;padding:6px 11px;border-radius:6px 0 0 6px;text-shadow:0 1px 1px rgba(0,0,0,.35)',
		'background:#2d3436;color:#ffeaa7;font-weight:bold;font-size:13px;padding:6px 11px;border-radius:0 6px 6px 0',
		'',
	)
}
