<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\WebSocket;

/**
 * Optional content fingerprint for a room. When set, every `JOIN` and every
 * `EPISODE_CHANGE_REQUEST` is reconciled against it: a mismatch is treated as
 * a safety failure rather than silently desynchronising playback across
 * different episodes or providers.
 */
class ContentIdentity {
	public readonly string $contentKey;

	public function __construct(
		public readonly string $providerId,
		public readonly string $episodeId,
		public readonly string $pageUrl,
	) {
		$this->contentKey = self::deriveKey($providerId, $episodeId, $pageUrl);
	}

	public static function deriveKey(string $providerId, string $episodeId, string $pageUrl): string {
		// Lowercased provider + episode keep simple typo-style mismatches from
		// looking like real ones; the URL is left alone because path case can
		// be load-bearing on some sites.
		return hash('sha256', strtolower($providerId) . ':' . strtolower($episodeId) . ':' . $pageUrl);
	}

	public function matches(string $providerId, string $episodeId, string $pageUrl): bool {
		return hash_equals($this->contentKey, self::deriveKey($providerId, $episodeId, $pageUrl));
	}
}
