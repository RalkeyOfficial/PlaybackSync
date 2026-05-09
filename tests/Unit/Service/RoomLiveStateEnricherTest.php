<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Service;

use OCA\PlaybackSync\Db\Room;
use OCA\PlaybackSync\Service\Dto\RoomLiveState;
use OCA\PlaybackSync\Service\PresenceClient;
use OCA\PlaybackSync\Service\RoomLiveStateEnricher;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class RoomLiveStateEnricherTest extends TestCase {

	private PresenceClient&MockObject $client;
	private RoomLiveStateEnricher $subject;

	protected function setUp(): void {
		parent::setUp();
		$this->client = $this->createMock(PresenceClient::class);
		$this->subject = new RoomLiveStateEnricher($this->client);
	}

	public function testEmptyRoomsListProducesEmptyMap(): void {
		$this->client->expects($this->never())->method('fetch');
		$this->assertSame([], $this->subject->enrich([]));
	}

	public function testReturnsNullForRoomsTheDaemonDoesntKnow(): void {
		$known = $this->makeRoom('11111111-1111-1111-1111-111111111111');
		$unknown = $this->makeRoom('22222222-2222-2222-2222-222222222222');

		$dto = new RoomLiveState(
			connectedCount: 1,
			clients: [['clientId' => 'alice', 'isBuffering' => false, 'lastSeenMs' => 1_700_000_000_000]],
			playerState: 'playing',
			videoPos: 12.5,
			contentIdentity: null,
			lastActivityMs: 1_700_000_000_000,
		);

		$this->client->expects($this->once())
			->method('fetch')
			->with([
				'11111111-1111-1111-1111-111111111111',
				'22222222-2222-2222-2222-222222222222',
			])
			->willReturn(['11111111-1111-1111-1111-111111111111' => $dto]);

		$result = $this->subject->enrich([$known, $unknown]);
		$this->assertSame($dto, $result['11111111-1111-1111-1111-111111111111']);
		$this->assertNull($result['22222222-2222-2222-2222-222222222222']);
	}

	public function testKeysInResultMatchInputOrder(): void {
		$rooms = [
			$this->makeRoom('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
			$this->makeRoom('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
		];
		$this->client->method('fetch')->willReturn([]);

		$result = $this->subject->enrich($rooms);
		$this->assertSame(
			['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
			array_keys($result),
		);
	}

	private function makeRoom(string $uuid): Room {
		$r = new Room();
		$r->setUuid($uuid);
		return $r;
	}
}
