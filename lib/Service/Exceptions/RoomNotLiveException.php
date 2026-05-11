<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when the daemon has no live runtime for the requested room — i.e.
 * no client has connected yet, so there's no in-memory state to mutate or
 * clients to broadcast to. Surfaced to the dashboard as 409 Conflict so it
 * can show a "no clients connected" hint.
 */
class RoomNotLiveException extends \RuntimeException {
}
