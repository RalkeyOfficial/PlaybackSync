<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\Dto\CursorChangeOutcome;
use OCA\PlaybackSync\Service\Dto\CursorTarget;
use OCA\PlaybackSync\Service\Exceptions\CursorEntryNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\NotInPlaylistException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistCapExceededException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistLockedException;
use OCA\PlaybackSync\Service\Exceptions\RoomNotFoundException;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IDBConnection;

/**
 * Owns the per-mode `CURSOR_CHANGE_REQUEST` reaction matrix. Wraps
 * every request in a single `SELECT ... FOR UPDATE` transaction on the
 * room row so cursor moves and any implicit auto-append serialise
 * cleanly against other writers.
 *
 * Per-mode wire rules from CONTENT_MODEL_PROTOCOL.md §reaction matrix:
 *
 * - **Single**, target by entry id → accept (cursor can still move
 *   between locked entries, rare but allowed).
 * - **Single**, target by raw video → reject `single_mode_locked`.
 * - **Default**, target by entry id → accept if entry exists.
 * - **Default**, target by raw video already in playlist → resolve to
 *   entry id, accept.
 * - **Default**, target by raw video not in playlist → reject
 *   `not_in_playlist`. The sender must `PLAYLIST_UPDATE` first.
 * - **Freeform**, target by entry id → accept if entry exists.
 * - **Freeform**, target by raw video → auto-append (existing key
 *   short-circuits to setCursor), then move cursor. Broadcast
 *   `PLAYLIST_UPDATE` before `CURSOR_CHANGE`.
 */
class CursorService {

	public function __construct(
		private readonly RoomMapper $mapper,
		private readonly IDBConnection $db,
		private readonly ITimeFactory $timeFactory,
	) {
	}

	public function requestChange(string $roomUuid, CursorTarget $target, string $clientId): CursorChangeOutcome {
		$this->db->beginTransaction();
		try {
			try {
				$room = $this->mapper->lockRoomForUpdate($roomUuid);
			} catch (DoesNotExistException) {
				throw new RoomNotFoundException('Room not found: ' . $roomUuid);
			}

			$previousCursorEntryId = $room->getCursorEntryId();
			$outcome = $this->resolveAndApply($room, $target, $clientId, $previousCursorEntryId);

			$this->db->commit();
			return $outcome;
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	private function resolveAndApply(Room $room, CursorTarget $target, string $clientId, ?string $previousCursorEntryId): CursorChangeOutcome {
		if ($target->isByEntryId()) {
			$entry = $this->findEntryById($room, (string)$target->entryId);
			if ($entry === null) {
				throw new CursorEntryNotFoundException('cursor target ' . $target->entryId . ' is not in the playlist');
			}
			return $this->commitCursorMove($room, $entry, appendedEntry: null, previousCursorEntryId: $previousCursorEntryId);
		}

		$ref = $target->videoRef;
		if ($ref === null) {
			// CursorTarget enforces this invariant at construction; this is a defensive guard.
			throw new \LogicException('CursorTarget has neither entryId nor videoRef');
		}

		$existing = $this->findEntryByVideoRef($room, $ref['providerId'], $ref['videoId']);

		if ($room->getSingleMode()) {
			if ($existing !== null) {
				return $this->commitCursorMove($room, $existing, appendedEntry: null, previousCursorEntryId: $previousCursorEntryId);
			}
			throw new PlaylistLockedException('playlist is locked while single mode is enabled');
		}

		if ($existing !== null) {
			return $this->commitCursorMove($room, $existing, appendedEntry: null, previousCursorEntryId: $previousCursorEntryId);
		}

		if (!$room->getFreeformMode()) {
			throw new NotInPlaylistException('target video is not in the playlist; send PLAYLIST_UPDATE first');
		}

		// Freeform + new video → auto-append + cursor move in one row write.
		$appended = $this->appendEntry($room, $ref, $clientId);
		return $this->commitCursorMove($room, $appended, appendedEntry: $appended, previousCursorEntryId: $previousCursorEntryId);
	}

	private function findEntryById(Room $room, string $entryId): ?PlaylistEntry {
		foreach ($room->getPlaylistEntries() as $entry) {
			if ($entry->entryId === $entryId) {
				return $entry;
			}
		}
		return null;
	}

	private function findEntryByVideoRef(Room $room, string $providerId, string $videoId): ?PlaylistEntry {
		$wantKey = strtolower($providerId) . '|' . strtolower($videoId);
		foreach ($room->getPlaylistEntries() as $entry) {
			if (strtolower($entry->providerId) . '|' . strtolower($entry->videoId) === $wantKey) {
				return $entry;
			}
		}
		return null;
	}

	/**
	 * @param array{providerId: string, videoId: string, pageUrl: string, label: ?string, episodeNumber: ?int, seasonNumber: ?int} $ref
	 */
	private function appendEntry(Room $room, array $ref, string $clientId): PlaylistEntry {
		$entries = $room->getPlaylistEntries();
		if (count($entries) + 1 > PlaylistService::PER_ROOM_CAP) {
			throw new PlaylistCapExceededException(
				PlaylistCapExceededException::CODE_PER_ROOM,
				'playlist would exceed per-room cap of ' . PlaylistService::PER_ROOM_CAP,
			);
		}
		$now = $this->timeFactory->getTime();
		$highest = 0;
		foreach ($entries as $entry) {
			if ($entry->position > $highest) {
				$highest = $entry->position;
			}
		}
		$entry = new PlaylistEntry(
			entryId: PlaylistEntry::generateEntryId(),
			position: $highest + 1,
			providerId: $ref['providerId'],
			videoId: $ref['videoId'],
			pageUrl: $ref['pageUrl'],
			label: $ref['label'],
			episodeNumber: $ref['episodeNumber'],
			seasonNumber: $ref['seasonNumber'],
			source: PlaylistEntry::SOURCE_AUTO_APPENDED,
			addedBy: $clientId,
			addedAt: $now,
			lastSeenAt: $now,
		);
		$entries[] = $entry;
		$room->setPlaylistEntries($entries);
		return $entry;
	}

	private function commitCursorMove(Room $room, PlaylistEntry $cursor, ?PlaylistEntry $appendedEntry, ?string $previousCursorEntryId): CursorChangeOutcome {
		$room->setCursorEntryId($cursor->entryId);
		$this->mapper->update($room);
		return new CursorChangeOutcome(
			cursor: $cursor,
			appendedEntry: $appendedEntry,
			playlist: $room->getPlaylistEntries(),
			previousCursorEntryId: $previousCursorEntryId,
		);
	}
}
