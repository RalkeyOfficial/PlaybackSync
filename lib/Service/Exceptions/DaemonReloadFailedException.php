<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when the loopback admin call asking the daemon to reload its config
 * could not be completed — daemon unreachable, HMAC misconfigured, or a non-200
 * response. A successful call means the live tunables were refreshed in place;
 * binding keys are intentionally untouched and still require a restart.
 */
class DaemonReloadFailedException extends \RuntimeException {
}
