<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\Exceptions\CursorEntryNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\CursorLockedEntryException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistCapExceededException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistLockedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IDBConnection;

/**
 * Owns every mutation of a room's playlist + cursor. Each public method
 * runs inside a single DB transaction with a `SELECT ... FOR UPDATE` lock
 * on the room row, so concurrent writers serialize cleanly against the
 * JSON-blob persistence shape — see CONTENT_MODEL_DATA.md §"Persistence
 * shape" for the rationale behind blob-over-table.
 *
 * Wire-protocol concerns (rate limiting, message rename, steering) live
 * outside this service. Callers shape user-facing errors from the typed
 * exceptions raised here.
 */
class PlaylistService {

	public const PER_MESSAGE_CAP = 200;
	public const PER_ROOM_CAP = 1000;

	public function __construct(
		private readonly RoomMapper $mapper,
		private readonly IDBConnection $db,
		private readonly ITimeFactory $timeFactory,
	) {
	}

	/**
	 * Merge a batch of candidate entries into the room's playlist using
	 * the rules from CONTENT_MODEL_DATA.md §"Merge rules":
	 *
	 * - Natural key is `(providerId, videoId)` (lowercased on compare).
	 * - New keys are appended with a server-assigned `entryId` and
	 *   `position`, taking the candidate's `source` (or `$defaultSource`
	 *   when omitted).
	 * - Existing curated entries are immutable except for `lastSeenAt`.
	 * - Existing non-curated entries take most-recent-scraped values for
	 *   `label` / `episodeNumber` / `seasonNumber`; `lastSeenAt` always
	 *   refreshes.
	 *
	 * Throws `PlaylistLockedException` when the room has `singleMode`
	 * enabled, `PlaylistCapExceededException` on cap violations, and
	 * `RoomNotFoundException` when the uuid is unknown. The whole call
	 * rolls back on any of these — no partial inserts.
	 *
	 * @param list<array<string, mixed>> $candidates Raw entry shapes
	 *        (must include `providerId`, `videoId`, `pageUrl`; may include
	 *        `label`, `episodeNumber`, `seasonNumber`, `source`, `addedBy`).
	 * @param string $defaultSource Used when a candidate omits `source`.
	 * @return list<PlaylistEntry> The full merged playlist after the call.
	 */
	public function merge(string $roomUuid, array $candidates, string $defaultSource, string $addedBy): array {
		if (count($candidates) > self::PER_MESSAGE_CAP) {
			throw new PlaylistCapExceededException(
				PlaylistCapExceededException::CODE_PER_MESSAGE,
				'PLAYLIST_UPDATE entry count exceeds per-message cap of ' . self::PER_MESSAGE_CAP,
			);
		}

		return $this->withRoomLock($roomUuid, function (Room $room) use ($candidates, $defaultSource, $addedBy): array {
			if ($room->getSingleMode()) {
				throw new PlaylistLockedException('playlist is locked while single mode is enabled');
			}

			$entries = $room->getPlaylistEntries();
			$byKey = [];
			foreach ($entries as $index => $entry) {
				$byKey[$this->mergeKey($entry->providerId, $entry->videoId)] = $index;
			}

			$now = $this->timeFactory->getTime();
			$nextPosition = $this->highestPosition($entries) + 1;
			$insertsPlanned = 0;

			foreach ($candidates as $candidate) {
				if (!isset($candidate['providerId'], $candidate['videoId'], $candidate['pageUrl'])) {
					continue;
				}
				$key = $this->mergeKey((string)$candidate['providerId'], (string)$candidate['videoId']);
				if (!isset($byKey[$key])) {
					$insertsPlanned++;
				}
			}

			if (count($entries) + $insertsPlanned > self::PER_ROOM_CAP) {
				throw new PlaylistCapExceededException(
					PlaylistCapExceededException::CODE_PER_ROOM,
					'playlist would exceed per-room cap of ' . self::PER_ROOM_CAP,
				);
			}

			foreach ($candidates as $candidate) {
				if (!isset($candidate['providerId'], $candidate['videoId'], $candidate['pageUrl'])) {
					continue;
				}
				$providerId = (string)$candidate['providerId'];
				$videoId = (string)$candidate['videoId'];
				$pageUrl = (string)$candidate['pageUrl'];
				$source = isset($candidate['source']) ? (string)$candidate['source'] : $defaultSource;
				$label = isset($candidate['label']) ? (string)$candidate['label'] : null;
				$episodeNumber = isset($candidate['episodeNumber']) ? (int)$candidate['episodeNumber'] : null;
				$seasonNumber = isset($candidate['seasonNumber']) ? (int)$candidate['seasonNumber'] : null;
				$candidateAddedBy = isset($candidate['addedBy']) ? (string)$candidate['addedBy'] : $addedBy;

				$key = $this->mergeKey($providerId, $videoId);
				if (isset($byKey[$key])) {
					$existing = $entries[$byKey[$key]];
					if ($existing->source === PlaylistEntry::SOURCE_CURATED) {
						$entries[$byKey[$key]] = $existing->with(lastSeenAt: $now);
					} else {
						$entries[$byKey[$key]] = $existing->with(
							label: $label ?? $existing->label,
							episodeNumber: $episodeNumber ?? $existing->episodeNumber,
							seasonNumber: $seasonNumber ?? $existing->seasonNumber,
							lastSeenAt: $now,
						);
					}
				} else {
					$new = new PlaylistEntry(
						entryId: PlaylistEntry::generateEntryId(),
						position: $nextPosition++,
						providerId: $providerId,
						videoId: $videoId,
						pageUrl: $pageUrl,
						label: $label,
						episodeNumber: $episodeNumber,
						seasonNumber: $seasonNumber,
						source: $source,
						addedBy: $candidateAddedBy,
						addedAt: $now,
						lastSeenAt: $now,
					);
					$entries[] = $new;
					$byKey[$key] = count($entries) - 1;
				}
			}

			$room->setPlaylistEntries($entries);
			$this->mapper->update($room);
			return $entries;
		});
	}

	/**
	 * Insert a single entry (source `auto_appended`) and move the cursor
	 * to it in one atomic write. Intended for the freeform-mode
	 * cursor-change path — the protocol spec invokes this when a viewer
	 * jumps to a video that isn't already in the playlist.
	 *
	 * Rejected when the room is in single mode (no growth allowed).
	 * Rejected when the entry would push the playlist past the per-room
	 * cap. Existing `(providerId, videoId)` short-circuits to `setCursor`.
	 *
	 * @param array{providerId: string, videoId: string, pageUrl: string, label?: string|null, episodeNumber?: int|null, seasonNumber?: int|null} $entryShape
	 */
	public function autoAppend(string $roomUuid, array $entryShape, string $clientId): PlaylistEntry {
		return $this->withRoomLock($roomUuid, function (Room $room) use ($entryShape, $clientId): PlaylistEntry {
			if ($room->getSingleMode()) {
				throw new PlaylistLockedException('playlist is locked while single mode is enabled');
			}

			$now = $this->timeFactory->getTime();
			$entries = $room->getPlaylistEntries();
			$key = $this->mergeKey($entryShape['providerId'], $entryShape['videoId']);

			foreach ($entries as $existing) {
				if ($this->mergeKey($existing->providerId, $existing->videoId) === $key) {
					$room->setCursorEntryId($existing->entryId);
					$this->mapper->update($room);
					return $existing;
				}
			}

			if (count($entries) + 1 > self::PER_ROOM_CAP) {
				throw new PlaylistCapExceededException(
					PlaylistCapExceededException::CODE_PER_ROOM,
					'playlist would exceed per-room cap of ' . self::PER_ROOM_CAP,
				);
			}

			$entry = new PlaylistEntry(
				entryId: PlaylistEntry::generateEntryId(),
				position: $this->highestPosition($entries) + 1,
				providerId: $entryShape['providerId'],
				videoId: $entryShape['videoId'],
				pageUrl: $entryShape['pageUrl'],
				label: $entryShape['label'] ?? null,
				episodeNumber: $entryShape['episodeNumber'] ?? null,
				seasonNumber: $entryShape['seasonNumber'] ?? null,
				source: PlaylistEntry::SOURCE_AUTO_APPENDED,
				addedBy: $clientId,
				addedAt: $now,
				lastSeenAt: $now,
			);
			$entries[] = $entry;
			$room->setPlaylistEntries($entries);
			$room->setCursorEntryId($entry->entryId);
			$this->mapper->update($room);
			return $entry;
		});
	}

	/**
	 * Move the cursor to an entry that already exists in the playlist.
	 * Throws `CursorEntryNotFoundException` if the entry id is unknown.
	 *
	 * Note: changing the cursor is allowed under every toggle combination
	 * — including single mode. Single mode locks the *playlist*, not the
	 * cursor (typically a single-mode room has one entry and this is a
	 * no-op, but the data model doesn't enforce that).
	 */
	public function setCursor(string $roomUuid, string $entryId): void {
		$this->withRoomLock($roomUuid, function (Room $room) use ($entryId): void {
			foreach ($room->getPlaylistEntries() as $entry) {
				if ($entry->entryId === $entryId) {
					$room->setCursorEntryId($entryId);
					$this->mapper->update($room);
					return;
				}
			}
			throw new CursorEntryNotFoundException('cursor target ' . $entryId . ' is not in the playlist');
		});
	}

	/**
	 * Remove an entry from the playlist. Disallowed in single mode.
	 * Disallowed when the entry is the current cursor — the caller must
	 * advance the cursor first. Renumbers `position` to stay contiguous.
	 */
	public function removeEntry(string $roomUuid, string $entryId): void {
		$this->withRoomLock($roomUuid, function (Room $room) use ($entryId): void {
			if ($room->getSingleMode()) {
				throw new PlaylistLockedException('playlist is locked while single mode is enabled');
			}
			if ($room->getCursorEntryId() === $entryId) {
				// Predictable: refuse to delete the entry under the cursor.
				// Owner advances the cursor first, then deletes.
				throw new CursorLockedEntryException('cannot delete the entry currently referenced by the cursor');
			}

			$entries = $room->getPlaylistEntries();
			$kept = [];
			$found = false;
			foreach ($entries as $entry) {
				if ($entry->entryId === $entryId) {
					$found = true;
					continue;
				}
				$kept[] = $entry;
			}
			if (!$found) {
				throw new CursorEntryNotFoundException('entry ' . $entryId . ' not found');
			}

			$renumbered = [];
			$pos = 1;
			foreach ($kept as $entry) {
				$renumbered[] = $entry->with(position: $pos++);
			}
			$room->setPlaylistEntries($renumbered);
			$this->mapper->update($room);
		});
	}

	/**
	 * Reorder the playlist by the supplied `entryId` sequence. The
	 * sequence must be a permutation of every existing entryId in the
	 * room — any missing or unknown id rolls the call back. Disallowed
	 * in single mode.
	 *
	 * @param list<string> $entryIdsInOrder
	 */
	public function reorderEntries(string $roomUuid, array $entryIdsInOrder): void {
		$this->withRoomLock($roomUuid, function (Room $room) use ($entryIdsInOrder): void {
			if ($room->getSingleMode()) {
				throw new PlaylistLockedException('playlist is locked while single mode is enabled');
			}

			$entries = $room->getPlaylistEntries();
			if (count($entries) !== count($entryIdsInOrder)) {
				throw new CursorEntryNotFoundException('reorder must include every existing entryId exactly once');
			}

			$byId = [];
			foreach ($entries as $entry) {
				$byId[$entry->entryId] = $entry;
			}

			$reordered = [];
			$pos = 1;
			foreach ($entryIdsInOrder as $entryId) {
				if (!isset($byId[$entryId])) {
					throw new CursorEntryNotFoundException('reorder includes unknown entryId ' . $entryId);
				}
				$reordered[] = $byId[$entryId]->with(position: $pos++);
				unset($byId[$entryId]);
			}
			if ($byId !== []) {
				throw new CursorEntryNotFoundException('reorder is missing some existing entryIds');
			}

			$room->setPlaylistEntries($reordered);
			$this->mapper->update($room);
		});
	}

	/**
	 * Flip an entry's `source` to `curated`, optionally overriding the
	 * label. After promotion, future scrapes of the same
	 * `(providerId, videoId)` only refresh `lastSeenAt` — the label and
	 * series metadata are sticky.
	 *
	 * Allowed even under single mode, because promotion does not grow
	 * the playlist.
	 */
	public function promoteToCurated(string $roomUuid, string $entryId, ?string $label): void {
		$this->withRoomLock($roomUuid, function (Room $room) use ($entryId, $label): void {
			$entries = $room->getPlaylistEntries();
			$updated = [];
			$found = false;
			foreach ($entries as $entry) {
				if ($entry->entryId === $entryId) {
					$found = true;
					$updated[] = $entry->with(
						label: $label ?? $entry->label,
						source: PlaylistEntry::SOURCE_CURATED,
					);
					continue;
				}
				$updated[] = $entry;
			}
			if (!$found) {
				throw new CursorEntryNotFoundException('entry ' . $entryId . ' not found');
			}
			$room->setPlaylistEntries($updated);
			$this->mapper->update($room);
		});
	}

	/**
	 * Bulk `lastSeenAt` refresh — does not touch labels or any other
	 * metadata. Used when a scrape reports entries that all happen to be
	 * curated already, where the merge logic would only update
	 * `lastSeenAt` anyway.
	 *
	 * @param list<array{providerId: string, videoId: string}> $entryRefs
	 */
	public function refreshLastSeenAt(string $roomUuid, array $entryRefs, int $now): void {
		if ($entryRefs === []) {
			return;
		}
		$this->withRoomLock($roomUuid, function (Room $room) use ($entryRefs, $now): void {
			$lookup = [];
			foreach ($entryRefs as $ref) {
				$lookup[$this->mergeKey($ref['providerId'], $ref['videoId'])] = true;
			}

			$entries = $room->getPlaylistEntries();
			$touched = false;
			$updated = [];
			foreach ($entries as $entry) {
				if (isset($lookup[$this->mergeKey($entry->providerId, $entry->videoId)])) {
					$updated[] = $entry->with(lastSeenAt: $now);
					$touched = true;
					continue;
				}
				$updated[] = $entry;
			}
			if (!$touched) {
				return;
			}
			$room->setPlaylistEntries($updated);
			$this->mapper->update($room);
		});
	}

	/**
	 * Execute `$fn` against a row-locked Room inside a single transaction.
	 * The fn's return value is propagated to the caller.
	 *
	 * @template T
	 * @param callable(Room): T $fn
	 * @return T
	 */
	private function withRoomLock(string $roomUuid, callable $fn): mixed {
		$this->db->beginTransaction();
		try {
			try {
				$room = $this->mapper->lockRoomForUpdate($roomUuid);
			} catch (DoesNotExistException) {
				throw new RoomNotFoundException('Room not found: ' . $roomUuid);
			}
			$result = $fn($room);
			$this->db->commit();
			return $result;
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	private function mergeKey(string $providerId, string $videoId): string {
		return strtolower($providerId) . '|' . strtolower($videoId);
	}

	/**
	 * @param list<PlaylistEntry> $entries
	 */
	private function highestPosition(array $entries): int {
		$max = 0;
		foreach ($entries as $entry) {
			if ($entry->position > $max) {
				$max = $entry->position;
			}
		}
		return $max;
	}
}
