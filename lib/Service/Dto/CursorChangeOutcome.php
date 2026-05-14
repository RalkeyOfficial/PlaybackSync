<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Dto;

use OCA\PlaybackSync\Db\PlaylistEntry;

/**
 * Result of `CursorService::requestChange`. Tells the caller (a WS
 * handler or HTTP controller) which broadcasts to emit:
 *
 * - `cursor` is the new playlist entry under the cursor.
 * - `appendedEntry` is non-null only when freeform auto-append created
 *   a new entry — the caller should broadcast a `PLAYLIST_UPDATE`
 *   carrying the full post-merge playlist *before* the `CURSOR_CHANGE`.
 * - `playlist` is the full post-state, used to build the
 *   `PLAYLIST_UPDATE` payload when `appendedEntry` is set.
 * - `previousCursorEntryId` is the entry the cursor used to point at
 *   (or null if it was unset). Used for the event-log payload.
 */
final class CursorChangeOutcome {

	/**
	 * @param list<PlaylistEntry> $playlist
	 */
	public function __construct(
		public readonly PlaylistEntry $cursor,
		public readonly ?PlaylistEntry $appendedEntry,
		public readonly array $playlist,
		public readonly ?string $previousCursorEntryId,
	) {
	}
}
