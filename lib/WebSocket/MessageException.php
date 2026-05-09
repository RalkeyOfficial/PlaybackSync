<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

use RuntimeException;

/**
 * Thrown by the validator and handlers to signal a protocol-level failure
 * that should be reported to the client as an `ERROR` message.
 *
 * `closeAfter` distinguishes recoverable failures (e.g., rate-limit) from
 * fatal ones (e.g., auth failure). The router uses it to decide whether to
 * close the underlying socket after writing the error frame.
 */
class MessageException extends RuntimeException {
	public function __construct(
		public readonly string $errorCode,
		string $message,
		public readonly bool $closeAfter = false,
	) {
		parent::__construct($message);
	}
}
