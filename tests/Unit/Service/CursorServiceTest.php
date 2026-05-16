<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Service;

use OCA\PlaybackSync\Db\PlaylistEntry;
use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Db\RoomMapper;
use OCA\PlaybackSync\Service\CursorService;
use OCA\PlaybackSync\Service\Dto\CursorTarget;
use OCA\PlaybackSync\Service\Exceptions\CursorEntryNotFoundException;
use OCA\PlaybackSync\Service\Exceptions\NotInPlaylistException;
use OCA\PlaybackSync\Service\Exceptions\PlaylistLockedException;
use OCA\PlaybackSync\Service\FreeformConfig;
use OCA\PlaybackSync\Service\PlaylistService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IDBConnection;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

/**
 * Covers every cell of the per-mode reaction matrix from
 * CONTENT_MODEL_PROTOCOL.md. The matrix is small enough that
 * exhaustive coverage is cheap and makes regressions on toggle logic
 * obvious in CI before they reach the wire.
 */
class CursorServiceTest extends TestCase {

	private const ROOM_UUID = '11111111-1111-4111-9111-111111111111';
	private const NOW_S = 1_700_000_000;

	private RoomMapper&MockObject $mapper;
	private IDBConnection&MockObject $db;
	private ITimeFactory&MockObject $timeFactory;
	private CursorService $service;

	protected function setUp(): void {
		parent::setUp();
		$this->mapper = $this->createMock(RoomMapper::class);
		$this->db = $this->createMock(IDBConnection::class);
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->timeFactory->method('getTime')->willReturn(self::NOW_S);
		$playlistService = new PlaylistService(
			$this->mapper,
			$this->db,
			$this->timeFactory,
			new FreeformConfig(autoAppendCap: 100),
		);
		$this->service = new CursorService($this->mapper, $this->db, $playlistService);
	}

	public function testDefaultModeMovesCursorByEntryId(): void {
		$room = $this->makeRoom(singleMode: false, freeformMode: false, entries: [
			$this->entry('e_01', 1, 'crunchyroll', 'frieren-01'),
			$this->entry('e_02', 2, 'crunchyroll', 'frieren-02'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndUpdate($room);

		$outcome = $this->service->requestChange(self::ROOM_UUID, CursorTarget::byEntryId('e_02'), 'client_a');

		$this->assertSame('e_02', $outcome->cursor->entryId);
		$this->assertNull($outcome->appendedEntry);
		$this->assertSame('e_01', $outcome->previousCursorEntryId);
	}

	public function testDefaultModeResolvesByVideoRefWhenEntryExists(): void {
		$room = $this->makeRoom(singleMode: false, freeformMode: false, entries: [
			$this->entry('e_01', 1, 'crunchyroll', 'frieren-01'),
			$this->entry('e_02', 2, 'crunchyroll', 'frieren-02'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndUpdate($room);

		$outcome = $this->service->requestChange(
			self::ROOM_UUID,
			CursorTarget::byVideoRef(['providerId' => 'crunchyroll', 'videoId' => 'frieren-02', 'pageUrl' => 'https://example.com/02']),
			'client_a',
		);

		$this->assertSame('e_02', $outcome->cursor->entryId);
		$this->assertNull($outcome->appendedEntry);
	}

	public function testDefaultModeRejectsRawVideoNotInPlaylist(): void {
		$room = $this->makeRoom(singleMode: false, freeformMode: false, entries: [
			$this->entry('e_01', 1, 'crunchyroll', 'frieren-01'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndRollback($room);

		$this->expectException(NotInPlaylistException::class);
		$this->service->requestChange(
			self::ROOM_UUID,
			CursorTarget::byVideoRef(['providerId' => 'crunchyroll', 'videoId' => 'never-seen', 'pageUrl' => 'https://example.com/x']),
			'client_a',
		);
	}

	public function testDefaultModeRejectsUnknownEntryId(): void {
		$room = $this->makeRoom(singleMode: false, freeformMode: false, entries: [
			$this->entry('e_01', 1, 'crunchyroll', 'frieren-01'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndRollback($room);

		$this->expectException(CursorEntryNotFoundException::class);
		$this->service->requestChange(self::ROOM_UUID, CursorTarget::byEntryId('e_99'), 'client_a');
	}

	public function testSingleModeMovesCursorByEntryId(): void {
		$room = $this->makeRoom(singleMode: true, freeformMode: false, entries: [
			$this->entry('e_01', 1, 'youtube', 'dQw4w9WgXcQ'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndUpdate($room);

		// Cursor stays on the same entry — single-mode rooms typically have
		// one entry, but moving between locked entries is allowed.
		$outcome = $this->service->requestChange(self::ROOM_UUID, CursorTarget::byEntryId('e_01'), 'client_a');
		$this->assertSame('e_01', $outcome->cursor->entryId);
	}

	public function testSingleModeRejectsRawVideoTargetingNewEntry(): void {
		$room = $this->makeRoom(singleMode: true, freeformMode: false, entries: [
			$this->entry('e_01', 1, 'youtube', 'dQw4w9WgXcQ'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndRollback($room);

		$this->expectException(PlaylistLockedException::class);
		$this->service->requestChange(
			self::ROOM_UUID,
			CursorTarget::byVideoRef(['providerId' => 'youtube', 'videoId' => 'newVid', 'pageUrl' => 'https://yt/x']),
			'client_a',
		);
	}

	public function testSingleModeResolvesRawVideoWhenEntryAlreadyExists(): void {
		$room = $this->makeRoom(singleMode: true, freeformMode: false, entries: [
			$this->entry('e_01', 1, 'youtube', 'dQw4w9WgXcQ'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndUpdate($room);

		// Even in single mode, a raw target that maps to an existing entry
		// is accepted — the playlist isn't growing.
		$outcome = $this->service->requestChange(
			self::ROOM_UUID,
			CursorTarget::byVideoRef(['providerId' => 'youtube', 'videoId' => 'dQw4w9WgXcQ', 'pageUrl' => 'https://yt/x']),
			'client_a',
		);
		$this->assertSame('e_01', $outcome->cursor->entryId);
	}

	public function testFreeformModeAutoAppendsNewVideoAndMovesCursor(): void {
		$room = $this->makeRoom(singleMode: false, freeformMode: true, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndUpdate($room);

		$outcome = $this->service->requestChange(
			self::ROOM_UUID,
			CursorTarget::byVideoRef(['providerId' => 'youtube', 'videoId' => 'vid_b', 'pageUrl' => 'https://yt/b', 'label' => 'New One']),
			'client_b',
		);

		$this->assertNotNull($outcome->appendedEntry);
		$this->assertSame('vid_b', $outcome->appendedEntry->videoId);
		$this->assertSame(PlaylistEntry::SOURCE_AUTO_APPENDED, $outcome->appendedEntry->source);
		$this->assertSame($outcome->appendedEntry->entryId, $outcome->cursor->entryId);
		$this->assertCount(2, $outcome->playlist);
	}

	public function testFreeformModeRawVideoInPlaylistResolvesToExistingEntry(): void {
		$room = $this->makeRoom(singleMode: false, freeformMode: true, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
			$this->entry('e_02', 2, 'youtube', 'vid_b'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndUpdate($room);

		$outcome = $this->service->requestChange(
			self::ROOM_UUID,
			CursorTarget::byVideoRef(['providerId' => 'youtube', 'videoId' => 'vid_b', 'pageUrl' => 'https://yt/b']),
			'client_a',
		);

		$this->assertSame('e_02', $outcome->cursor->entryId);
		$this->assertNull($outcome->appendedEntry);
		$this->assertCount(2, $outcome->playlist);
	}

	public function testFreeformModeAcceptsExistingEntryId(): void {
		$room = $this->makeRoom(singleMode: false, freeformMode: true, entries: [
			$this->entry('e_01', 1, 'youtube', 'vid_a'),
			$this->entry('e_02', 2, 'youtube', 'vid_b'),
		], cursorEntryId: 'e_01');
		$this->expectRoomLockAndUpdate($room);

		$outcome = $this->service->requestChange(self::ROOM_UUID, CursorTarget::byEntryId('e_02'), 'client_a');
		$this->assertSame('e_02', $outcome->cursor->entryId);
	}

	/**
	 * Run a room through the lock + commit happy path. The mapper's
	 * `lockRoomForUpdate` returns the supplied entity, `update` echoes
	 * the entity back, and we expect a single commit on `IDBConnection`.
	 */
	private function expectRoomLockAndUpdate(Room $room): void {
		$this->db->expects($this->once())->method('beginTransaction');
		$this->db->expects($this->once())->method('commit');
		$this->db->expects($this->never())->method('rollBack');
		$this->mapper->method('lockRoomForUpdate')->with(self::ROOM_UUID)->willReturn($room);
		$this->mapper->method('update')->willReturnArgument(0);
	}

	/**
	 * Variant for rejection paths: we still lock + begin, but the
	 * service throws so we expect a rollback instead of a commit.
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
	private function makeRoom(bool $singleMode, bool $freeformMode, array $entries, ?string $cursorEntryId): Room {
		$room = new Room();
		$room->setUuid(self::ROOM_UUID);
		$room->setOwnerUserId('alice');
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

	private function entry(string $entryId, int $position, string $providerId, string $videoId, string $source = PlaylistEntry::SOURCE_SCRAPED): PlaylistEntry {
		return new PlaylistEntry(
			entryId: $entryId,
			position: $position,
			providerId: $providerId,
			videoId: $videoId,
			pageUrl: 'https://example.com/' . $videoId,
			label: 'Episode ' . $position,
			episodeNumber: $position,
			seasonNumber: 1,
			source: $source,
			addedBy: 'client_test',
			addedAt: self::NOW_S - 1000,
			lastSeenAt: self::NOW_S - 100,
		);
	}
}
