<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when a caller attempts to set both `singleMode` and `freeformMode`
 * to true on the same room. Wire-protocol mapping: `toggle_conflict`.
 *
 * The two toggles are mutually exclusive by design: singleMode forbids
 * playlist growth, freeformMode requires it.
 */
class ToggleConflictException extends \RuntimeException {
}
