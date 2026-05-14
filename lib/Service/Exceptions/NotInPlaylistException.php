<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when a default-mode cursor change targets a raw video reference
 * that is not in the room's playlist. The sender must contribute the
 * entry via `PLAYLIST_UPDATE` first and then retry the cursor request.
 * Wire-protocol mapping: `not_in_playlist`.
 */
class NotInPlaylistException extends \RuntimeException {
}
