<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when a delete targets the entry currently referenced by the
 * cursor. Predictable behaviour: the caller must advance the cursor
 * first, then delete. Wire-protocol mapping: `cursor_locked_entry`.
 */
class CursorLockedEntryException extends \RuntimeException {
}
