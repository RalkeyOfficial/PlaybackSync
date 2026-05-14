<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCA\PlaybackSync\Service\RoomService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\AnonRateLimit;
use OCP\AppFramework\Http\Attribute\BruteForceProtection;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\RedirectResponse;
use OCP\AppFramework\Http\Response;
use OCP\IRequest;
use OCP\IURLGenerator;

/**
 * Public Basic-Auth gate for room share links.
 *
 * Visitors hit `/apps/playbacksync/r/{uuid}` with the link the room owner
 * shared. The browser surfaces a native password prompt; on a correct
 * password we redirect to `room.bootstrapUrl` with `sync_url` and `sync_password`
 * query parameters appended so a downstream consumer (browser extension,
 * embedded player) can join the synchronized session.
 *
 * The contract — including the Basic Auth parsing rules, the 302 status, and
 * the query-merge semantics — mirrors the original Fastify implementation in
 * `OLD_CODE/server/src/routes/share.ts`.
 */
class ShareController extends Controller {

	public function __construct(
		string $appName,
		IRequest $request,
		private readonly RoomService $rooms,
		private readonly IURLGenerator $urlGenerator,
	) {
		parent::__construct($appName, $request);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: 'playbacksync_share')]
	#[AnonRateLimit(limit: 60, period: 60)]
	public function show(string $uuid): Response {
		try {
			$room = $this->rooms->getActiveRoom($uuid);
		} catch (RoomNotFoundException) {
			// Unknown and expired collapse to the same surface — never tell the
			// caller which it was.
			return new DataResponse(['error' => 'not_found'], Http::STATUS_NOT_FOUND);
		}

		$auth = $this->request->getHeader('Authorization');
		$password = $this->extractBasicPassword($auth);

		// No / malformed credentials: prompt the browser without counting it
		// as a failed attempt. Only verified-but-wrong passwords feed the
		// brute-force throttler.
		if ($password === null) {
			return $this->unauthorized($uuid, throttle: false);
		}

		if (!$this->rooms->verifyPassword($room, $password)) {
			return $this->unauthorized($uuid, throttle: true);
		}

		$redirectUrl = $this->buildRedirectUrl($room->getBootstrapUrl(), $uuid, $password);
		// Explicit 302 — RedirectResponse defaults to 303, which would change
		// the method semantics from the OLD_CODE contract.
		return new RedirectResponse($redirectUrl, Http::STATUS_FOUND);
	}

	private function unauthorized(string $uuid, bool $throttle): DataResponse {
		$response = new DataResponse(['error' => 'unauthorized'], Http::STATUS_UNAUTHORIZED);
		$response->addHeader('WWW-Authenticate', 'Basic realm="Room ' . $uuid . '"');
		if ($throttle) {
			$response->throttle(['action' => 'playbacksync_share']);
		}
		return $response;
	}

	/**
	 * Extract the password from a `Basic` Authorization header.
	 *
	 * Returns `null` for a missing, non-Basic, or otherwise unparseable header.
	 * Username is intentionally ignored to match the OLD_CODE behaviour and to
	 * accommodate browsers that strip user info from URLs. Splitting on the
	 * first `:` keeps passwords containing colons intact.
	 */
	private function extractBasicPassword(string $authHeader): ?string {
		if ($authHeader === '' || !str_starts_with($authHeader, 'Basic ')) {
			return null;
		}

		$encoded = substr($authHeader, 6);
		$decoded = base64_decode($encoded, true);
		if ($decoded === false) {
			return null;
		}

		$parts = explode(':', $decoded, 2);
		if (count($parts) !== 2) {
			return null;
		}

		return $parts[1];
	}

	/**
	 * Build the post-auth redirect URL.
	 *
	 * Merges `sync_url` (the WebSocket URL the daemon answers on) and
	 * `sync_password` (the plaintext just verified) into the target URL's
	 * query string, preserving any existing parameters and the fragment.
	 */
	private function buildRedirectUrl(string $bootstrapUrl, string $uuid, string $password): string {
		$wsUrl = $this->buildWebSocketUrl($uuid);

		$parts = parse_url($bootstrapUrl);
		if ($parts === false) {
			// Defensive: bootstrapUrl was validated at room-creation time, so
			// reaching here would mean the row is corrupt. Fall back to the
			// raw URL with the params appended — better than 500ing.
			$parts = ['path' => $bootstrapUrl];
		}

		$existing = [];
		if (isset($parts['query']) && $parts['query'] !== '') {
			parse_str($parts['query'], $existing);
		}
		$existing['sync_url'] = $wsUrl;
		$existing['sync_password'] = $password;
		$parts['query'] = http_build_query($existing);

		return $this->reassembleUrl($parts);
	}

	private function buildWebSocketUrl(string $uuid): string {
		$abs = $this->urlGenerator->getAbsoluteURL('/apps/playbacksync/ws/' . $uuid);
		// Reverse-proxy upgrades happen on the same host that served the
		// page request — swap the scheme rather than constructing an
		// independent URL.
		if (str_starts_with($abs, 'https://')) {
			return 'wss://' . substr($abs, 8);
		}
		if (str_starts_with($abs, 'http://')) {
			return 'ws://' . substr($abs, 7);
		}
		return $abs;
	}

	/**
	 * @param array{
	 *     scheme?: string,
	 *     host?: string,
	 *     port?: int,
	 *     user?: string,
	 *     pass?: string,
	 *     path?: string,
	 *     query?: string,
	 *     fragment?: string
	 * } $parts
	 */
	private function reassembleUrl(array $parts): string {
		$out = '';
		if (isset($parts['scheme'])) {
			$out .= $parts['scheme'] . '://';
		}
		if (isset($parts['user'])) {
			$out .= $parts['user'];
			if (isset($parts['pass'])) {
				$out .= ':' . $parts['pass'];
			}
			$out .= '@';
		}
		if (isset($parts['host'])) {
			$out .= $parts['host'];
		}
		if (isset($parts['port'])) {
			$out .= ':' . $parts['port'];
		}
		if (isset($parts['path'])) {
			$out .= $parts['path'];
		}
		if (isset($parts['query']) && $parts['query'] !== '') {
			$out .= '?' . $parts['query'];
		}
		if (isset($parts['fragment'])) {
			$out .= '#' . $parts['fragment'];
		}
		return $out;
	}
}
