<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Service;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\Exceptions\CursorEntryNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\InvalidEntryPatchException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistLockedException;
use OCA\PlaybackSync\Service\FreeformConfig;
use OCA\PlaybackSync\Service\PlaylistService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IDBConnection;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

/**
 * Covers the per-mode invariants and the two default-mode additions
 * (`updateEntry`, `clearAll`). Merge rules and `removeEntry` already
 * have indirect coverage via `CursorServiceTest` and the protocol
 * spec's handler tests; this file pins the dashboard-driven edits.
 */
class PlaylistServiceTest extends TestCase {

	private const ROOM_UUID = '22222222-2222-4222-9222-222222222222';
	private const NOW_S = 1_700_000_000;

	private RoomMapper&MockObject $mapper;
	private IDBConnection&MockObject $db;
	private ITimeFactory&MockObject $timeFactory;
	private PlaylistService $service;

	protected function setUp(): void {
		parent::setUp();
		$this->mapper = $this->createMock(RoomMapper::class);
		$this->db = $this->createMock(IDBConnection::class);
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->timeFactory->method('getTime')->willReturn(self::NOW_S);
		$this->service = new PlaylistService(
			$this->mapper,
			$this->db,
			$this->timeFactory,
			new FreeformConfig(autoAppendCap: 100),
		);
	}

	public function testMergePreservesCuratedLabelOnRescrape(): void {
		$room = $this->makeRoom(singleMode: false, entries: [
			$this->entry('e_01', 1, 'crunchyroll', 'frieren-01', label: 'Episode 1 — The Journey\'s End', source: PlaylistEntry::SOURCE_CURATED),
		]);
		$this->expectRoomLockAndUpdate($room);

		$merged = $this->service->merge(
			self::ROOM_UUID,
			[[
				'providerId' => 'crunchyroll',
				'videoId' => 'frieren-01',
				'pageUrl' => 'https://example.com/01',
				'label' => 'Episode 1', // bare scrape label
			]],
			PlaylistEntry::SOURCE_SCRAPED,
			'client_a',
		);

		$this->assertSame('Episode 1 — The Journey\'s End', $merged[0]->label, 'curated labels are sticky');
		$this->assertSame(self::NOW_S, $merged[0]->lastSeenAt, 'lastSeenAt always refreshes');
	}

	public function testMergeOverwritesScrapedLabelOnRescrape(): void {
		$room = $this->makeRoom(singleMode: false, entries: [
			$this->entry('e_01', 1, 'crunchyroll', 'frieren-12', label: 'Episode 12: TBA', source: PlaylistEntry::SOURCE_SCRAPED),
		]);
		$this->expectRoomLockAndUpdate($room);

		$merged = $this->service->merge(
			self::ROOM_UUID,
			[[
				'providerId' => 'crunchyroll',
				'videoId' => 'frieren-12',
				'pageUrl' => 'https://example.com/12',
				'label' => 'Episode 12: The Final Battle',
			]],
			PlaylistEntry::SOURCE_SCRAPED,
			'client_a',
		);

		$this->assertSame('Episode 12: The Final Battle', $merged[0]->label, 'scraped labels take most-recent value');
	}

	public function testUpdateEntryEditsLabel(): void {
		$room = $this->makeRoom(singleMode: false, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
			$this->entry('e_02', 2, 'youtube', 'vid_b'),
		]);
		$this->expectRoomLockAndUpdate($room);

		$updated = $this->service->updateEntry(self::ROOM_UUID, 'e_02', label: 'New Title', episodeNumber: null, seasonNumber: null, position: null, source: null);

		$this->assertSame('New Title', $updated->label);
		$this->assertSame(2, $updated->position, 'position untouched when omitted');
	}

	public function testUpdateEntryPromotesScrapedToCurated(): void {
		$room = $this->makeRoom(singleMode: false, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a', source: PlaylistEntry::SOURCE_SCRAPED),
		]);
		$this->expectRoomLockAndUpdate($room);

		$updated = $this->service->updateEntry(self::ROOM_UUID, 'e_01', label: null, episodeNumber: null, seasonNumber: null, position: null, source: PlaylistEntry::SOURCE_CURATED);

		$this->assertSame(PlaylistEntry::SOURCE_CURATED, $updated->source);
	}

	public function testUpdateEntryRejectsInvalidSourceTransition(): void {
		// Throws before locking — no commit/rollback expected.
		$this->expectException(InvalidEntryPatchException::class);
		$this->service->updateEntry(self::ROOM_UUID, 'e_01', label: null, episodeNumber: null, seasonNumber: null, position: null, source: PlaylistEntry::SOURCE_SCRAPED);
	}

	public function testUpdateEntryMovesPositionAndRenumbersNeighbours(): void {
		$room = $this->makeRoom(singleMode: false, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
			$this->entry('e_02', 2, 'youtube', 'vid_b'),
			$this->entry('e_03', 3, 'youtube', 'vid_c'),
			$this->entry('e_04', 4, 'youtube', 'vid_d'),
		]);
		$this->expectRoomLockAndUpdate($room);

		$updated = $this->service->updateEntry(self::ROOM_UUID, 'e_03', label: null, episodeNumber: null, seasonNumber: null, position: 1, source: null);

		$this->assertSame(1, $updated->position, 'patched entry lands at the requested position');

		$entries = $room->getPlaylistEntries();
		$byId = [];
		foreach ($entries as $entry) {
			$byId[$entry->entryId] = $entry->position;
		}
		$this->assertSame(1, $byId['e_03'], 'moved entry sits at position 1');
		$this->assertSame(2, $byId['e_01'], 'displaced entries shift down');
		$this->assertSame(3, $byId['e_02']);
		$this->assertSame(4, $byId['e_04']);
	}

	public function testUpdateEntryRejectsPositionMoveInSingleMode(): void {
		$room = $this->makeRoom(singleMode: true, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
			$this->entry('e_02', 2, 'youtube', 'vid_b'),
		]);
		$this->expectRoomLockAndRollback($room);

		$this->expectException(PlaylistLockedException::class);
		$this->service->updateEntry(self::ROOM_UUID, 'e_02', label: null, episodeNumber: null, seasonNumber: null, position: 1, source: null);
	}

	public function testUpdateEntryAllowsMetadataEditInSingleMode(): void {
		$room = $this->makeRoom(singleMode: true, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
		]);
		$this->expectRoomLockAndUpdate($room);

		// Metadata edits don't grow or reorder the playlist; allowed under lock.
		$updated = $this->service->updateEntry(self::ROOM_UUID, 'e_01', label: 'Renamed', episodeNumber: null, seasonNumber: null, position: null, source: null);
		$this->assertSame('Renamed', $updated->label);
	}

	public function testUpdateEntryRejectsUnknownEntryId(): void {
		$room = $this->makeRoom(singleMode: false, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
		]);
		$this->expectRoomLockAndRollback($room);

		$this->expectException(CursorEntryNotFoundException::class);
		$this->service->updateEntry(self::ROOM_UUID, 'e_missing', label: 'x', episodeNumber: null, seasonNumber: null, position: null, source: null);
	}

	public function testClearAllWipesPlaylistAndCursor(): void {
		$room = $this->makeRoom(singleMode: false, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
			$this->entry('e_02', 2, 'youtube', 'vid_b'),
		], cursorEntryId: 'e_02');
		$this->expectRoomLockAndUpdate($room);

		$this->service->clearAll(self::ROOM_UUID);

		$this->assertSame([], $room->getPlaylistEntries());
		$this->assertNull($room->getCursorEntryId());
	}

	public function testClearAllRejectedInSingleMode(): void {
		$room = $this->makeRoom(singleMode: true, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndRollback($room);

		$this->expectException(PlaylistLockedException::class);
		$this->service->clearAll(self::ROOM_UUID);
	}

	/**
	 * Run a room through the lock + commit happy path.
	 */
	private function expectRoomLockAndUpdate(Room $room): void {
		$this->db->expects($this->once())->method('beginTransaction');
		$this->db->expects($this->once())->method('commit');
		$this->db->expects($this->never())->method('rollBack');
		$this->mapper->method('lockRoomForUpdate')->with(self::ROOM_UUID)->willReturn($room);
		$this->mapper->method('update')->willReturnArgument(0);
	}

	/**
	 * Variant for rejection paths: lock + begin, then rollback.
	 */
	private function expectRoomLockAndRollback(Room $room): void {
		$this->db->expects($this->once())->method('beginTransaction');
		$this->db->expects($this->never())->method('commit');
		$this->db->expects($this->once())->method('rollBack');
		$this->mapper->method('lockRoomForUpdate')->with(self::ROOM_UUID)->willReturn($room);
	}

	/**
	 * @param list<PlaylistEntry> $entries
	 */
	private function makeRoom(bool $singleMode, array $entries, ?string $cursorEntryId = null): Room {
		$room = new Room();
		$room->setUuid(self::ROOM_UUID);
		$room->setOwnerUserId('alice');
		$room->setBootstrapUrl('https://example.com/');
		$room->setPasswordHash('hash');
		$room->setSingleMode($singleMode);
		$room->setFreeformMode(false);
		$room->setPlaylistEntries($entries);
		$room->setCursorEntryId($cursorEntryId);
		$room->setCreatedAt(0);
		$room->setExpiresAt(self::NOW_S * 1000 + 3_600_000);
		return $room;
	}

	private function entry(
		string $entryId,
		int $position,
		string $providerId,
		string $videoId,
		?string $label = null,
		string $source = PlaylistEntry::SOURCE_SCRAPED,
	): PlaylistEntry {
		return new PlaylistEntry(
			entryId: $entryId,
			position: $position,
			providerId: $providerId,
			videoId: $videoId,
			pageUrl: 'https://example.com/' . $videoId,
			label: $label ?? ('Episode ' . $position),
			episodeNumber: $position,
			seasonNumber: 1,
			source: $source,
			addedBy: 'client_test',
			addedAt: self::NOW_S - 1000,
			lastSeenAt: self::NOW_S - 100,
		);
	}
}
