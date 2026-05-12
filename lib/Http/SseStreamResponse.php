<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Http;

use OCP\AppFramework\Http\ICallbackResponse;
use OCP\AppFramework\Http\IOutput;
use OCP\AppFramework\Http\Response;

/**
 * Nextcloud response that holds the FPM worker open and streams Server-Sent
 * Events to the client. Implements `ICallbackResponse` so the framework hands
 * us an `IOutput` *after* headers have been flushed; we then run the
 * caller-supplied producer closure which is responsible for echoing bytes and
 * calling `flush()` between writes.
 *
 * The framework's `Content-Length` defaulting only applies when the dispatcher
 * has a string body to emit — implementing `ICallbackResponse` skips that
 * branch, so no length header is added and the connection-close framing the
 * SSE wire relies on stays intact.
 */
class SseStreamResponse extends Response implements ICallbackResponse {

	/** @var \Closure(IOutput): void */
	private \Closure $producer;

	/**
	 * @param \Closure(IOutput): void $producer Called once with the framework's
	 *                                          IOutput; should loop, echo, and
	 *                                          flush() until the upstream ends
	 *                                          or the client disconnects.
	 */
	public function __construct(\Closure $producer) {
		parent::__construct();
		$this->producer = $producer;
		$this->addHeader('Content-Type', 'text/event-stream');
		$this->addHeader('Cache-Control', 'no-store');
		$this->addHeader('X-Accel-Buffering', 'no');
	}

	public function callback(IOutput $output): void {
		// Drain any framework / FPM output buffer so writes from the producer
		// reach the socket immediately instead of pooling until callback exit.
		while (ob_get_level() > 0) {
			@ob_end_flush();
		}
		// Disable transparent gzip — encoders that buffer would defeat SSE.
		if (function_exists('apache_setenv')) {
			@apache_setenv('no-gzip', '1');
		}
		@ini_set('zlib.output_compression', '0');
		@ini_set('output_buffering', '0');
		@ini_set('implicit_flush', '1');

		($this->producer)($output);
	}
}
