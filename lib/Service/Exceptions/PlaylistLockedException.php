<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when a mutation is attempted against a playlist that is locked
 * by `singleMode = true`. Wire-protocol mapping: `single_mode_locked`.
 */
class PlaylistLockedException extends \RuntimeException {
}
