<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\Service\HealthClient;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;

/**
 * Public passthrough for the WebSocket daemon's `/healthz` endpoint.
 *
 * The daemon binds its admin port to loopback only, so external probes can't
 * reach `/healthz` directly. This route gives them a stable URL on the
 * Nextcloud webroot, with a thin reachability envelope wrapped around the
 * daemon's body.
 *
 * Always responds HTTP 200. A healthcheck that 5xxs is itself a worse signal
 * than one that says `status: degraded` — load balancers and humans alike
 * misread the former. `#[PublicPage]` because probes can't authenticate; the
 * response is intentionally free of sensitive data (no UUIDs, no client IDs,
 * no IPs, no secrets).
 */
class HealthController extends Controller {

	public function __construct(
		string $appName,
		IRequest $request,
		private readonly HealthClient $client,
	) {
		parent::__construct($appName, $request);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function index(): JSONResponse {
		$probe = $this->client->fetch();

		if ($probe['reachable'] === false) {
			return new JSONResponse([
				'status' => 'degraded',
				'daemon' => [
					'reachable' => false,
					'error' => $probe['error'],
				],
			]);
		}

		$body = $probe['body'];
		$daemonStatus = is_array($body) && isset($body['status']) && $body['status'] === 'ok'
			? 'ok'
			: 'degraded';

		return new JSONResponse([
			'status' => $daemonStatus,
			'daemon' => [
				'reachable' => true,
				'latency_ms' => $probe['latency_ms'],
				'body' => $body,
			],
		]);
	}
}
