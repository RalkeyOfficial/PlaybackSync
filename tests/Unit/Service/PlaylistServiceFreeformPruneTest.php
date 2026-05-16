<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Service;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\Exceptions\PlaylistCapExceededException;
use OCA\PlaybackSync\Service\FreeformConfig;
use OCA\PlaybackSync\Service\PlaylistService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IDBConnection;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

/**
 * Pins the freeform auto-append cap policy from CONTENT_MODEL_FREEFORM.md
 * §Auto-prune. The behaviour is exercised through `autoAppend` (the only
 * public entry point that triggers the prune helper), with the cap kept
 * deliberately small in each test so an entire scenario fits in a
 * handful of entries.
 *
 * Scenarios covered:
 *   - under cap → no drops (sanity)
 *   - over cap, all eligible → oldest `auto_appended` dropped
 *   - cursored entry preserved even when it's the oldest auto_appended
 *   - curated entries protected — never auto-dropped
 *   - curated-saturated freeform → `freeform_cap_full` raised
 *   - default-mode room → prune skipped entirely (helper guards on toggle)
 */
class PlaylistServiceFreeformPruneTest extends TestCase {

	private const ROOM_UUID = '33333333-3333-4333-9333-333333333333';
	private const NOW_S = 1_700_000_000;

	private RoomMapper&MockObject $mapper;
	private IDBConnection&MockObject $db;
	private ITimeFactory&MockObject $timeFactory;

	protected function setUp(): void {
		parent::setUp();
		$this->mapper = $this->createMock(RoomMapper::class);
		$this->db = $this->createMock(IDBConnection::class);
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->timeFactory->method('getTime')->willReturn(self::NOW_S);
	}

	public function testAutoAppendUnderCapDropsNothing(): void {
		$service = $this->serviceWithCap(10);
		$room = $this->freeformRoom([
			$this->entry('e_01', 1, 'vid_1', addedAt: self::NOW_S - 500, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
			$this->entry('e_02', 2, 'vid_2', addedAt: self::NOW_S - 400, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
		], cursorEntryId: 'e_02');
		$this->expectRoomLockAndUpdate($room);

		$service->autoAppend(self::ROOM_UUID, $this->shape('vid_3'), 'client_a');

		$this->assertCount(3, $room->getPlaylistEntries(), 'no entries dropped when under cap');
		$this->assertSame(['e_01', 'e_02'], $this->existingIds($room, ['vid_1', 'vid_2']));
	}

	public function testAutoAppendDropsOldestAutoAppendedFirst(): void {
		$service = $this->serviceWithCap(3);
		$room = $this->freeformRoom([
			$this->entry('e_01', 1, 'vid_1', addedAt: self::NOW_S - 500, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
			$this->entry('e_02', 2, 'vid_2', addedAt: self::NOW_S - 400, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
			$this->entry('e_03', 3, 'vid_3', addedAt: self::NOW_S - 300, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
		], cursorEntryId: 'e_03');
		$this->expectRoomLockAndUpdate($room);

		$service->autoAppend(self::ROOM_UUID, $this->shape('vid_4'), 'client_a');

		$entries = $room->getPlaylistEntries();
		$this->assertCount(3, $entries, 'list shrinks back to cap after append + prune');
		$videoIds = array_map(static fn (PlaylistEntry $e): string => $e->videoId, $entries);
		$this->assertSame(['vid_2', 'vid_3', 'vid_4'], $videoIds, 'oldest auto_appended (vid_1) dropped first');
		// Positions renumber contiguously from 1.
		$positions = array_map(static fn (PlaylistEntry $e): int => $e->position, $entries);
		$this->assertSame([1, 2, 3], $positions);
	}

	public function testMergePreservesCursoredEntryEvenWhenOldest(): void {
		// `autoAppend` always moves the cursor to the just-inserted entry, so
		// the cursor-preservation guarantee is most naturally observable via
		// `merge()` — which can push the playlist over cap without touching
		// the cursor. Scraped fragments in freeform rooms are unusual but
		// possible (e.g. a `catalogFragment` on JOIN), and the prune helper
		// must still spare whatever the room is currently watching.
		$service = $this->serviceWithCap(3);
		$room = $this->freeformRoom([
			$this->entry('e_01', 1, 'vid_1', addedAt: self::NOW_S - 500, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
			$this->entry('e_02', 2, 'vid_2', addedAt: self::NOW_S - 400, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
			$this->entry('e_03', 3, 'vid_3', addedAt: self::NOW_S - 300, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndUpdate($room);

		// Adding two scraped entries pushes count to 5; prune must drop two,
		// and the cursored e_01 must survive even though it is the oldest.
		$service->merge(
			self::ROOM_UUID,
			[
				['providerId' => 'youtube', 'videoId' => 'vid_scraped_a', 'pageUrl' => 'https://example.com/vid_scraped_a'],
				['providerId' => 'youtube', 'videoId' => 'vid_scraped_b', 'pageUrl' => 'https://example.com/vid_scraped_b'],
			],
			PlaylistEntry::SOURCE_SCRAPED,
			'client_a',
		);

		$videoIds = array_map(static fn (PlaylistEntry $e): string => $e->videoId, $room->getPlaylistEntries());
		$this->assertCount(3, $videoIds, 'list shrinks back to cap after merge + prune');
		$this->assertContains('vid_1', $videoIds, 'cursored entry survives even though it is the oldest');
		$this->assertNotContains('vid_2', $videoIds, 'oldest non-cursored auto_appended dropped first');
		$this->assertNotContains('vid_3', $videoIds, 'next-oldest non-cursored auto_appended dropped second');
		$this->assertContains('vid_scraped_a', $videoIds, 'newly scraped entries are kept');
		$this->assertContains('vid_scraped_b', $videoIds);
	}

	public function testAutoAppendNeverDropsCuratedEntries(): void {
		$service = $this->serviceWithCap(3);
		$room = $this->freeformRoom([
			// Curated entries are deliberately the oldest — prune must still skip them.
			$this->entry('e_01', 1, 'vid_curated', addedAt: self::NOW_S - 5000, source: PlaylistEntry::SOURCE_CURATED),
			$this->entry('e_02', 2, 'vid_auto_a', addedAt: self::NOW_S - 400, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
			$this->entry('e_03', 3, 'vid_auto_b', addedAt: self::NOW_S - 300, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
		], cursorEntryId: 'e_03');
		$this->expectRoomLockAndUpdate($room);

		$service->autoAppend(self::ROOM_UUID, $this->shape('vid_new'), 'client_a');

		$videoIds = array_map(static fn (PlaylistEntry $e): string => $e->videoId, $room->getPlaylistEntries());
		$this->assertContains('vid_curated', $videoIds, 'curated entry never dropped');
		$this->assertNotContains('vid_auto_a', $videoIds, 'oldest auto_appended dropped instead');
		$this->assertContains('vid_auto_b', $videoIds);
		$this->assertContains('vid_new', $videoIds);
	}

	public function testAutoAppendThrowsFreeformCapFullWhenOnlyCuratedRemain(): void {
		$service = $this->serviceWithCap(2);
		$room = $this->freeformRoom([
			$this->entry('e_01', 1, 'vid_a', addedAt: self::NOW_S - 500, source: PlaylistEntry::SOURCE_CURATED),
			$this->entry('e_02', 2, 'vid_b', addedAt: self::NOW_S - 400, source: PlaylistEntry::SOURCE_CURATED),
		], cursorEntryId: 'e_02');
		$this->expectRoomLockAndRollback($room);

		try {
			$service->autoAppend(self::ROOM_UUID, $this->shape('vid_c'), 'client_a');
			$this->fail('expected PlaylistCapExceededException');
		} catch (PlaylistCapExceededException $e) {
			$this->assertSame(
				PlaylistCapExceededException::CODE_FREEFORM_CAP,
				$e->capCode,
				'wire code identifies the freeform-specific cap',
			);
		}
	}

	public function testAutoAppendInDefaultModeRoomSkipsPrune(): void {
		$service = $this->serviceWithCap(2);
		// Default-mode (not freeform) room: prune helper must short-circuit even when over cap.
		$room = $this->makeRoom(singleMode: false, freeformMode: false, entries: [
			$this->entry('e_01', 1, 'vid_1', addedAt: self::NOW_S - 500, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
			$this->entry('e_02', 2, 'vid_2', addedAt: self::NOW_S - 400, source: PlaylistEntry::SOURCE_AUTO_APPENDED),
		], cursorEntryId: 'e_02');
		$this->expectRoomLockAndUpdate($room);

		$service->autoAppend(self::ROOM_UUID, $this->shape('vid_3'), 'client_a');

		$this->assertCount(3, $room->getPlaylistEntries(), 'default-mode room grows past freeform cap — prune is no-op');
	}

	private function serviceWithCap(int $cap): PlaylistService {
		return new PlaylistService(
			$this->mapper,
			$this->db,
			$this->timeFactory,
			new FreeformConfig(autoAppendCap: $cap),
		);
	}

	/**
	 * @param list<PlaylistEntry> $entries
	 */
	private function freeformRoom(array $entries, ?string $cursorEntryId): Room {
		return $this->makeRoom(singleMode: false, freeformMode: true, entries: $entries, cursorEntryId: $cursorEntryId);
	}

	/**
	 * @param list<PlaylistEntry> $entries
	 */
	private function makeRoom(bool $singleMode, bool $freeformMode, array $entries, ?string $cursorEntryId): Room {
		$room = new Room();
		$room->setUuid(self::ROOM_UUID);
		$room->setOwnerUserId('erin');
		$room->setBootstrapUrl('https://example.com/');
		$room->setPasswordHash('hash');
		$room->setSingleMode($singleMode);
		$room->setFreeformMode($freeformMode);
		$room->setPlaylistEntries($entries);
		$room->setCursorEntryId($cursorEntryId);
		$room->setCreatedAt(0);
		$room->setExpiresAt(self::NOW_S * 1000 + 3_600_000);
		return $room;
	}

	private function entry(
		string $entryId,
		int $position,
		string $videoId,
		int $addedAt,
		string $source,
	): PlaylistEntry {
		return new PlaylistEntry(
			entryId: $entryId,
			position: $position,
			providerId: 'youtube',
			videoId: $videoId,
			pageUrl: 'https://example.com/' . $videoId,
			label: $videoId,
			episodeNumber: null,
			seasonNumber: null,
			source: $source,
			addedBy: 'client_test',
			addedAt: $addedAt,
			lastSeenAt: $addedAt,
		);
	}

	/**
	 * @return array{providerId: string, videoId: string, pageUrl: string, label: null, episodeNumber: null, seasonNumber: null}
	 */
	private function shape(string $videoId): array {
		return [
			'providerId' => 'youtube',
			'videoId' => $videoId,
			'pageUrl' => 'https://example.com/' . $videoId,
			'label' => null,
			'episodeNumber' => null,
			'seasonNumber' => null,
		];
	}

	private function expectRoomLockAndUpdate(Room $room): void {
		$this->db->expects($this->once())->method('beginTransaction');
		$this->db->expects($this->once())->method('commit');
		$this->db->expects($this->never())->method('rollBack');
		$this->mapper->method('lockRoomForUpdate')->with(self::ROOM_UUID)->willReturn($room);
		$this->mapper->method('update')->willReturnArgument(0);
	}

	private function expectRoomLockAndRollback(Room $room): void {
		$this->db->expects($this->once())->method('beginTransaction');
		$this->db->expects($this->never())->method('commit');
		$this->db->expects($this->once())->method('rollBack');
		$this->mapper->method('lockRoomForUpdate')->with(self::ROOM_UUID)->willReturn($room);
	}

	/**
	 * @param list<string> $expectedVideoIds
	 * @return list<string> the entryIds of the surviving entries in playlist order
	 */
	private function existingIds(Room $room, array $expectedVideoIds): array {
		$result = [];
		foreach ($room->getPlaylistEntries() as $entry) {
			if (in_array($entry->videoId, $expectedVideoIds, true)) {
				$result[] = $entry->entryId;
			}
		}
		return $result;
	}
}
