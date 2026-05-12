import type { TimestampFormat } from '../types/userSettings.ts'

import { translate as t } from '@nextcloud/l10n'

/**
 * Render a positive millisecond duration as a coarse "X unit ago" string.
 * Falls back to "just now" under a minute so freshly created entities don't
 * make their captions churn second-by-second.
 *
 * @param ms how long ago the event happened, in milliseconds
 * @return localized relative-time string, e.g. "5m ago"
 */
export function formatRelativePast(ms: number): string {
	if (ms < 60_000) {
		return t('playbacksync', 'just now')
	}
	const minutes = Math.floor(ms / 60_000)
	if (minutes < 60) {
		return t('playbacksync', '{n}m ago', { n: minutes })
	}
	const hours = Math.floor(minutes / 60)
	if (hours < 24) {
		return t('playbacksync', '{n}h ago', { n: hours })
	}
	const days = Math.floor(hours / 24)
	return t('playbacksync', '{n}d ago', { n: days })
}

/**
 * Format a unix-millis timestamp as a locale-aware short date+time string.
 *
 * @param ms unix timestamp in milliseconds
 * @return e.g. "5/12/2026, 8:36 AM" — exact form is decided by the browser locale
 */
export function formatAbsolute(ms: number): string {
	try {
		return new Date(ms).toLocaleString()
	} catch {
		return ''
	}
}

/**
 * Render a past timestamp respecting the user's preferred format. `relative`
 * gives the rolling "5m ago" style; `absolute` shows the locale-aware date.
 *
 * @param timestampMs the past event time in unix milliseconds
 * @param nowMs       the current time in unix milliseconds (used only when
 *                    `format === 'relative'`)
 * @param format      the user's choice between rolling-relative or locale-absolute
 */
export function formatTimestamp(timestampMs: number, nowMs: number, format: TimestampFormat): string {
	if (format === 'absolute') {
		return formatAbsolute(timestampMs)
	}
	return formatRelativePast(nowMs - timestampMs)
}
