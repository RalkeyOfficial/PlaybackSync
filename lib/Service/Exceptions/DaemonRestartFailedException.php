<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when the loopback admin call asking the daemon to restart could not be
 * completed — daemon unreachable, HMAC misconfigured, or a non-200 response.
 *
 * Note this only reports whether the *request to exit* was accepted. It does
 * not (and cannot) confirm the daemon came back up: that depends on an external
 * supervisor and is verified separately by polling the WS status endpoint.
 */
class DaemonRestartFailedException extends \RuntimeException {
}
