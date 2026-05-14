<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Db;

use OCP\AppFramework\Db\Entity;
use OCP\DB\Types;

/**
 * @method int getId()
 * @method void setId(int $id)
 * @method string getUuid()
 * @method void setUuid(string $uuid)
 * @method string getOwnerUserId()
 * @method void setOwnerUserId(string $ownerUserId)
 * @method string|null getName()
 * @method void setName(?string $name)
 * @method string getBootstrapUrl()
 * @method void setBootstrapUrl(string $bootstrapUrl)
 * @method string getPasswordHash()
 * @method void setPasswordHash(string $passwordHash)
 * @method bool getSingleMode()
 * @method void setSingleMode(bool $singleMode)
 * @method bool getFreeformMode()
 * @method void setFreeformMode(bool $freeformMode)
 * @method string getPlaylist()
 * @method void setPlaylist(string $playlist)
 * @method string|null getCursorEntryId()
 * @method void setCursorEntryId(?string $cursorEntryId)
 * @method int getCreatedAt()
 * @method void setCreatedAt(int $createdAt)
 * @method int getExpiresAt()
 * @method void setExpiresAt(int $expiresAt)
 */
class Room extends Entity {

	/** @var string */
	public $uuid;

	/** @var string */
	public $ownerUserId;

	/** @var string|null */
	public $name;

	/** @var string */
	public $bootstrapUrl;

	/** @var string */
	public $passwordHash;

	/** @var bool */
	public $singleMode = false;

	/** @var bool */
	public $freeformMode = false;

	/**
	 * Raw JSON-serialized playlist. Use `getPlaylistEntries()` /
	 * `setPlaylistEntries()` for the typed view.
	 *
	 * @var string
	 */
	public $playlist = '[]';

	/** @var string|null */
	public $cursorEntryId;

	/** @var int */
	public $createdAt;

	/** @var int */
	public $expiresAt;

	public function __construct() {
		$this->addType('uuid', 'string');
		$this->addType('ownerUserId', 'string');
		$this->addType('name', 'string');
		$this->addType('bootstrapUrl', 'string');
		$this->addType('passwordHash', 'string');
		$this->addType('singleMode', Types::BOOLEAN);
		$this->addType('freeformMode', Types::BOOLEAN);
		$this->addType('playlist', 'string');
		$this->addType('cursorEntryId', 'string');
		$this->addType('createdAt', Types::BIGINT);
		$this->addType('expiresAt', Types::BIGINT);
	}

	/**
	 * Decode the playlist JSON blob into typed entries, sorted by `position`.
	 *
	 * @return list<PlaylistEntry>
	 */
	public function getPlaylistEntries(): array {
		$raw = $this->playlist === null || $this->playlist === '' ? '[]' : $this->playlist;
		$decoded = json_decode($raw, true);
		if (!is_array($decoded)) {
			return [];
		}
		$entries = [];
		foreach ($decoded as $row) {
			if (!is_array($row)) {
				continue;
			}
			$entries[] = PlaylistEntry::fromArray($row);
		}
		usort($entries, static fn (PlaylistEntry $a, PlaylistEntry $b): int => $a->position <=> $b->position);
		return $entries;
	}

	/**
	 * Replace the playlist with the supplied entries. Serializes to the
	 * raw JSON column and marks the field as updated so QBMapper sees the
	 * change. Caller is responsible for `position` continuity — this
	 * method does not renumber.
	 *
	 * @param list<PlaylistEntry> $entries
	 */
	public function setPlaylistEntries(array $entries): void {
		$rows = array_map(static fn (PlaylistEntry $e): array => $e->toArray(), $entries);
		$encoded = json_encode($rows, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
		$this->setPlaylist($encoded);
	}

	/**
	 * Return the playlist entry currently referenced by `cursorEntryId`,
	 * or null when the cursor is unset or stale (the referenced entry has
	 * been removed). Linear scan — fine at the 1000-entry per-room cap.
	 */
	public function getCursorEntry(): ?PlaylistEntry {
		if ($this->cursorEntryId === null) {
			return null;
		}
		foreach ($this->getPlaylistEntries() as $entry) {
			if ($entry->entryId === $this->cursorEntryId) {
				return $entry;
			}
		}
		return null;
	}
}
