<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when a cursor change references an `entryId` that doesn't exist
 * in the room's playlist. Callers must `merge()` the entry first, or — in
 * freeform mode — go through `PlaylistService::autoAppend` which inserts
 * the entry and moves the cursor atomically.
 */
class CursorEntryNotFoundException extends \RuntimeException {
}
