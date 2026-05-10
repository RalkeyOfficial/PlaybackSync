<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\Handler\HeartbeatHandler;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\PlaybackState;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use OCA\PlaybackSync\WebSocket\WsConfig;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class HeartbeatHandlerTest extends TestCase {

	private const UUID = '33333333-3333-4333-9333-333333333333';
	private const NOW = 1_000_000;

	private RoomRegistry $registry;
	private HeartbeatHandler $handler;
	private WsConfig $config;

	protected function setUp(): void {
		parent::setUp();
		$this->registry = new RoomRegistry(eventLogSize: 50);
		// Long cooldown of 0 to keep tests focused on drift math.
		$this->config = new WsConfig(5000, 30000, 30000, 30000, 50, 10, 200, 500, 0);
		$this->handler = new HeartbeatHandler($this->registry, new MessageEncoder(), $this->config);
	}

	private function setupClient(int $playEventTs = 0): array {
		$runtime = $this->registry->getOrCreate(self::UUID, self::NOW + 60_000);
		$conn = $this->createMock(ConnectionInterface::class);
		$client = new ClientConnection('A', $conn, self::NOW, 0, new RateLimiter(10, self::NOW));
		$runtime->addClient($client);
		// Pretend room is currently playing, started at videoPos=0 at $playEventTs.
		$runtime->state = new PlaybackState(PlaybackState::PLAYING, 0.0, $playEventTs, $playEventTs, 0);
		$ctx = new ConnectionContext(self::UUID);
		$ctx->joined = true;
		$ctx->clientId = 'A';
		return [$runtime, $conn, $ctx];
	}

	public function testNoActionWhenDriftBelowNudgeThreshold(): void {
		[, $conn, $ctx] = $this->setupClient(playEventTs: self::NOW - 10_000);
		// expectedTime = 10s elapsed since play; client reports 10.05s = 50ms drift, below 200ms.
		$conn->expects($this->never())->method('send');
		$this->handler->handle($conn, $ctx, ['currentPos' => 10.05, 'playerState' => 'playing'], self::NOW);
	}

	public function testNudgeWhenDriftBetweenThresholds(): void {
		[, $conn, $ctx] = $this->setupClient(playEventTs: self::NOW - 10_000);
		// 300ms drift.
		$captured = null;
		$conn->expects($this->once())->method('send')
			->willReturnCallback(function (string $f) use (&$captured): void { $captured = $f; });
		$this->handler->handle($conn, $ctx, ['currentPos' => 10.3, 'playerState' => 'playing'], self::NOW);
		$decoded = json_decode($captured, true);
		$this->assertSame('SYNC_ADJUST', $decoded['type']);
		$this->assertSame('nudge-rate', $decoded['mode']);
	}

	public function testSeekWhenDriftAboveSeekThreshold(): void {
		[, $conn, $ctx] = $this->setupClient(playEventTs: self::NOW - 10_000);
		// 800ms drift.
		$captured = null;
		$conn->expects($this->once())->method('send')
			->willReturnCallback(function (string $f) use (&$captured): void { $captured = $f; });
		$this->handler->handle($conn, $ctx, ['currentPos' => 10.8, 'playerState' => 'playing'], self::NOW);
		$decoded = json_decode($captured, true);
		$this->assertSame('SYNC_ADJUST', $decoded['type']);
		$this->assertSame('seek', $decoded['mode']);
	}

	public function testBufferingClientIsNeverCorrected(): void {
		[, $conn, $ctx] = $this->setupClient(playEventTs: self::NOW - 10_000);
		$conn->expects($this->never())->method('send');
		$this->handler->handle($conn, $ctx, ['currentPos' => 5.0, 'playerState' => 'buffering'], self::NOW);
	}

	public function testCooldownSuppressesCorrection(): void {
		// Use a fresh registry with a non-zero cooldown.
		$this->registry = new RoomRegistry(eventLogSize: 50);
		$this->config = new WsConfig(5000, 30000, 30000, 30000, 50, 10, 200, 500, 3000);
		$this->handler = new HeartbeatHandler($this->registry, new MessageEncoder(), $this->config);

		// Play happened 1s ago; cooldown is 3s, so no correction even with big drift.
		[, $conn, $ctx] = $this->setupClient(playEventTs: self::NOW - 1000);
		$conn->expects($this->never())->method('send');
		$this->handler->handle($conn, $ctx, ['currentPos' => 5.0, 'playerState' => 'playing'], self::NOW);
	}
}
