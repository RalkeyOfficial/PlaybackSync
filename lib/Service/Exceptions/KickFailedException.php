<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when the loopback admin call to disconnect a client failed for an
 * operational reason — daemon down, HMAC misconfigured, network error, or a
 * non-204/404 response. Distinct from `ClientNotFoundException`, which means
 * the daemon answered authoritatively that no such client is connected.
 */
class KickFailedException extends \RuntimeException {
}
