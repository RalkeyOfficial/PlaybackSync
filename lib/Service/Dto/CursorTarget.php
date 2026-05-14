<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Dto;

/**
 * Input for `CursorService::requestChange`. Either references an
 * existing playlist entry by id, or describes a raw video the caller
 * proposes as the new cursor (used in freeform mode for auto-append,
 * and in default mode to resolve a request issued by `videoId` to an
 * existing entry).
 *
 * Construct via `byEntryId()` or `byVideoRef()` — never both.
 */
final class CursorTarget {

	/**
	 * @param array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int}|null $videoRef
	 */
	private function __construct(
		public readonly ?string $entryId,
		public readonly ?array $videoRef,
	) {
	}

	public static function byEntryId(string $entryId): self {
		return new self($entryId, null);
	}

	/**
	 * @param array{providerId: string, videoId: string, pageUrl: string, label?: ?string, episodeNumber?: ?int, seasonNumber?: ?int} $videoRef
	 */
	public static function byVideoRef(array $videoRef): self {
		return new self(null, [
			'providerId' => $videoRef['providerId'],
			'videoId' => $videoRef['videoId'],
			'pageUrl' => $videoRef['pageUrl'],
			'label' => $videoRef['label'] ?? null,
			'episodeNumber' => $videoRef['episodeNumber'] ?? null,
			'seasonNumber' => $videoRef['seasonNumber'] ?? null,
		]);
	}

	public function isByEntryId(): bool {
		return $this->entryId !== null;
	}
}
