<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Db;

/**
 * One entry in a room's playlist. Pure value object — serialized to/from
 * the `playlist` JSON column on `playbacksync_rooms`.
 *
 * Field shape mirrors the JSON contract defined in CONTENT_MODEL_DATA.md
 * §"Playlist entry shape". Referential integrity for the room's
 * `cursorEntryId` field (which must reference some entry's `entryId`)
 * is enforced at the service layer, not here.
 */
final class PlaylistEntry {

	public const SOURCE_SCRAPED = 'scraped';
	public const SOURCE_CURATED = 'curated';
	public const SOURCE_AUTO_APPENDED = 'auto_appended';

	/**
	 * @param string      $entryId       Server-assigned, opaque, stable. `e_` + 16 hex chars. Unique within the room.
	 * @param int         $position      1-based ordering within the playlist. Server-managed; renumbered on insert/reorder.
	 * @param string      $providerId    Provider slug (e.g. `youtube`, `crunchyroll`). Lowercased on merge.
	 * @param string      $videoId       Provider-specific video identifier. Lowercased on merge.
	 * @param string      $pageUrl       Tab-navigation target broadcast on cursor changes.
	 * @param string|null $label         Human-readable title. Null when the source provided none.
	 * @param int|null    $episodeNumber Series-aware episode index, or playlist position for YouTube playlists. Null otherwise.
	 * @param int|null    $seasonNumber  Optional season metadata. Omitted for non-seasoned providers.
	 * @param string      $source        One of `scraped`, `curated`, `auto_appended` — see class constants.
	 * @param string      $addedBy       Client id (or `owner`) that introduced the entry. Provenance only.
	 * @param int         $addedAt       Unix seconds at insert time.
	 * @param int         $lastSeenAt    Unix seconds; refreshed every time a scrape reports this `(providerId, videoId)`.
	 */
	public function __construct(
		public readonly string $entryId,
		public readonly int $position,
		public readonly string $providerId,
		public readonly string $videoId,
		public readonly string $pageUrl,
		public readonly ?string $label,
		public readonly ?int $episodeNumber,
		public readonly ?int $seasonNumber,
		public readonly string $source,
		public readonly string $addedBy,
		public readonly int $addedAt,
		public readonly int $lastSeenAt,
	) {
	}

	/**
	 * Build a PlaylistEntry from a parsed-JSON associative array. Missing
	 * optional fields default to null; required fields must be present.
	 *
	 * Caller is responsible for validating the input shape — this helper
	 * trusts that the JSON came from the room's own `playlist` column or
	 * from a similarly-shaped wire payload that the protocol layer has
	 * already validated.
	 *
	 * @param array<string, mixed> $row
	 */
	public static function fromArray(array $row): self {
		return new self(
			entryId: (string)$row['entryId'],
			position: (int)$row['position'],
			providerId: (string)$row['providerId'],
			videoId: (string)$row['videoId'],
			pageUrl: (string)$row['pageUrl'],
			label: isset($row['label']) ? (string)$row['label'] : null,
			episodeNumber: isset($row['episodeNumber']) ? (int)$row['episodeNumber'] : null,
			seasonNumber: isset($row['seasonNumber']) ? (int)$row['seasonNumber'] : null,
			source: (string)$row['source'],
			addedBy: (string)$row['addedBy'],
			addedAt: (int)$row['addedAt'],
			lastSeenAt: (int)$row['lastSeenAt'],
		);
	}

	/**
	 * Inverse of `fromArray`. Returns the JSON-ready array shape that the
	 * Room entity persists.
	 *
	 * @return array{
	 *     entryId: string,
	 *     position: int,
	 *     providerId: string,
	 *     videoId: string,
	 *     pageUrl: string,
	 *     label: ?string,
	 *     episodeNumber: ?int,
	 *     seasonNumber: ?int,
	 *     source: string,
	 *     addedBy: string,
	 *     addedAt: int,
	 *     lastSeenAt: int
	 * }
	 */
	public function toArray(): array {
		return [
			'entryId' => $this->entryId,
			'position' => $this->position,
			'providerId' => $this->providerId,
			'videoId' => $this->videoId,
			'pageUrl' => $this->pageUrl,
			'label' => $this->label,
			'episodeNumber' => $this->episodeNumber,
			'seasonNumber' => $this->seasonNumber,
			'source' => $this->source,
			'addedBy' => $this->addedBy,
			'addedAt' => $this->addedAt,
			'lastSeenAt' => $this->lastSeenAt,
		];
	}

	/**
	 * Generate a fresh, room-unique `entryId`. Format: `e_` + 16 hex chars
	 * (8 cryptographically random bytes). Opaque to clients; stable for
	 * the entry's lifetime.
	 */
	public static function generateEntryId(): string {
		return 'e_' . bin2hex(random_bytes(8));
	}

	/**
	 * Return a new entry that copies this one with the supplied fields
	 * overridden. Used by merge logic to avoid in-place mutation of
	 * immutable value objects.
	 */
	public function with(
		?int $position = null,
		?string $label = null,
		?int $episodeNumber = null,
		?int $seasonNumber = null,
		?string $source = null,
		?int $lastSeenAt = null,
	): self {
		return new self(
			entryId: $this->entryId,
			position: $position ?? $this->position,
			providerId: $this->providerId,
			videoId: $this->videoId,
			pageUrl: $this->pageUrl,
			label: $label ?? $this->label,
			episodeNumber: $episodeNumber ?? $this->episodeNumber,
			seasonNumber: $seasonNumber ?? $this->seasonNumber,
			source: $source ?? $this->source,
			addedBy: $this->addedBy,
			addedAt: $this->addedAt,
			lastSeenAt: $lastSeenAt ?? $this->lastSeenAt,
		);
	}
}
