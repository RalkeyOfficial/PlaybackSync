<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCP\Http\Client\IClientService;
use OCP\ICache;
use OCP\ICacheFactory;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Out-of-band metadata fetcher for the dashboard "single-mode" create flow.
 *
 * Calls the provider's public oEmbed endpoint to retrieve a friendly title
 * (and provider name) for a pasted URL so the create dialog can pre-fill
 * the entry label. Best-effort: a failure NEVER throws — the dialog still
 * submits with `label: null` and the owner can hand-type one. Results are
 * cached per URL for an hour so retries inside the same dialog session
 * stay snappy.
 */
class OembedLookupService {

	public const TIMEOUT_SECONDS = 3.0;
	public const CACHE_TTL_SECONDS = 3600;

	private readonly ICache $cache;

	public function __construct(
		private readonly IClientService $clientService,
		private readonly LoggerInterface $logger,
		ICacheFactory $cacheFactory,
	) {
		$this->cache = $cacheFactory->createDistributed(Application::APP_ID . '.oembed');
	}

	/**
	 * Fetch oEmbed metadata for a URL.
	 *
	 * @param string $pageUrl    The canonical page URL (already normalised
	 *                            by `VideoUrlParser`).
	 * @param string $providerId One of `youtube`, `vimeo`, or `generic`.
	 *                            `generic` short-circuits and returns null.
	 *
	 * @return array{title: string, providerName: string, thumbnailUrl: ?string}|null
	 *         `null` when the provider isn't supported, the call failed,
	 *         the response wasn't valid JSON, or the payload was missing
	 *         the title.
	 */
	public function fetch(string $pageUrl, string $providerId): ?array {
		$endpoint = $this->endpointFor($providerId, $pageUrl);
		if ($endpoint === null) {
			return null;
		}

		$cacheKey = sha1($pageUrl);
		$cached = $this->cache->get($cacheKey);
		if (is_array($cached)) {
			return $this->shapeFromArray($cached);
		}

		try {
			$response = $this->clientService->newClient()->get($endpoint, [
				'headers' => ['Accept' => 'application/json'],
				'timeout' => self::TIMEOUT_SECONDS,
				'connect_timeout' => self::TIMEOUT_SECONDS,
				'http_errors' => false,
			]);
		} catch (Throwable $e) {
			$this->logger->info('OembedLookupService request failed', [
				'providerId' => $providerId,
				'exception' => $e,
			]);
			return null;
		}

		$status = $response->getStatusCode();
		if ($status !== 200) {
			$this->logger->info('OembedLookupService got non-200', [
				'providerId' => $providerId,
				'status' => $status,
			]);
			return null;
		}

		$decoded = json_decode((string)$response->getBody(), true);
		if (!is_array($decoded) || !isset($decoded['title']) || !is_string($decoded['title'])) {
			$this->logger->info('OembedLookupService got malformed body', ['providerId' => $providerId]);
			return null;
		}

		$shape = $this->shapeFromArray($decoded);
		if ($shape !== null) {
			$this->cache->set($cacheKey, $shape, self::CACHE_TTL_SECONDS);
		}
		return $shape;
	}

	private function endpointFor(string $providerId, string $pageUrl): ?string {
		return match ($providerId) {
			'youtube' => 'https://www.youtube.com/oembed?format=json&url=' . rawurlencode($pageUrl),
			'vimeo' => 'https://vimeo.com/api/oembed.json?url=' . rawurlencode($pageUrl),
			default => null,
		};
	}

	/**
	 * @param array<string, mixed> $raw
	 * @return array{title: string, providerName: string, thumbnailUrl: ?string}|null
	 */
	private function shapeFromArray(array $raw): ?array {
		$title = $raw['title'] ?? null;
		if (!is_string($title) || $title === '') {
			return null;
		}
		$providerName = $raw['provider_name'] ?? $raw['providerName'] ?? null;
		$thumbnail = $raw['thumbnail_url'] ?? $raw['thumbnailUrl'] ?? null;
		return [
			'title' => $title,
			'providerName' => is_string($providerName) ? $providerName : '',
			'thumbnailUrl' => is_string($thumbnail) ? $thumbnail : null,
		];
	}
}
