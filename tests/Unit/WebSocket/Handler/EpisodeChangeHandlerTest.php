<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\Handler\EpisodeChangeHandler;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\PlaybackState;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class EpisodeChangeHandlerTest extends TestCase {

	private const UUID = '44444444-4444-4444-9444-444444444444';
	private const NOW = 1_000_000;

	public function testHardResetsStateAndBroadcastsToEveryone(): void {
		$registry = new RoomRegistry(50);
		$runtime = $registry->getOrCreate(self::UUID, self::NOW + 60_000);
		$runtime->state = new PlaybackState(PlaybackState::PLAYING, 120.0, self::NOW - 5000, self::NOW - 5000, 7);

		$connA = $this->createMock(ConnectionInterface::class);
		$connB = $this->createMock(ConnectionInterface::class);
		$runtime->addClient(new ClientConnection('A', 'NickA', $connA, self::NOW, 0, new RateLimiter(10, self::NOW)));
		$runtime->addClient(new ClientConnection('B', 'NickB', $connB, self::NOW, 0, new RateLimiter(10, self::NOW)));

		$capturedB = null;
		$connA->expects($this->once())->method('send'); // sender also receives
		$connB->expects($this->once())->method('send')
			->willReturnCallback(function (string $f) use (&$capturedB): void { $capturedB = $f; });

		$ctx = new ConnectionContext(self::UUID);
		$ctx->joined = true;
		$ctx->clientId = 'A';

		$handler = new EpisodeChangeHandler($registry, new MessageEncoder());
		$handler->handle($connA, $ctx, [
			'episodeId' => 'S02E03',
			'providerId' => 'netflix',
			'pageUrl' => 'https://example.com/watch/2',
			'clientTs' => 0,
		], self::NOW);

		$this->assertSame(0.0, $runtime->state->videoPos);
		$this->assertSame(PlaybackState::PAUSED, $runtime->state->playerState);
		$this->assertSame(8, $runtime->state->eventId);

		$decoded = json_decode($capturedB, true);
		$this->assertSame('EPISODE_CHANGE', $decoded['type']);
		$this->assertSame('S02E03', $decoded['episodeId']);
		$this->assertSame(8, $decoded['eventId']);
	}
}
