<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ClientConnection;
use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\Handler\EventHandler;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\PlaybackState;
use OCA\PlaybackSync\WebSocket\RateLimiter;
use OCA\PlaybackSync\WebSocket\RoomRegistry;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class EventHandlerTest extends TestCase {

	private const UUID = '22222222-2222-4222-9222-222222222222';
	private const NOW = 1_000_000;

	private RoomRegistry $registry;
	private MessageEncoder $encoder;
	private EventHandler $handler;

	protected function setUp(): void {
		parent::setUp();
		$this->registry = new RoomRegistry(eventLogSize: 50);
		$this->encoder = new MessageEncoder();
		$this->handler = new EventHandler($this->registry, $this->encoder);
	}

	private function setupTwoClients(): array {
		$runtime = $this->registry->getOrCreate(self::UUID, self::NOW + 60_000);
		$connA = $this->createMock(ConnectionInterface::class);
		$connB = $this->createMock(ConnectionInterface::class);
		$runtime->addClient(new ClientConnection('A', 'NickA', $connA, self::NOW, 0, new RateLimiter(10, self::NOW), new RateLimiter(2, self::NOW)));
		$runtime->addClient(new ClientConnection('B', 'NickB', $connB, self::NOW, 0, new RateLimiter(10, self::NOW), new RateLimiter(2, self::NOW)));
		return [$runtime, $connA, $connB];
	}

	public function testRequiresPriorJoin(): void {
		$conn = $this->createMock(ConnectionInterface::class);
		$ctx = new ConnectionContext(self::UUID); // not joined
		$this->expectException(MessageException::class);
		$this->handler->handle($conn, $ctx, ['event' => 'play', 'value' => null, 'clientTs' => 0], self::NOW);
	}

	public function testPlayBroadcastsStateToAllClients(): void {
		[, $connA, $connB] = $this->setupTwoClients();

		$ctx = new ConnectionContext(self::UUID);
		$ctx->joined = true;
		$ctx->clientId = 'A';

		$framesA = [];
		$framesB = [];
		$connA->method('send')->willReturnCallback(function (string $f) use (&$framesA): void { $framesA[] = $f; });
		$connB->method('send')->willReturnCallback(function (string $f) use (&$framesB): void { $framesB[] = $f; });

		$this->handler->handle($connA, $ctx, ['event' => 'play', 'value' => null, 'clientTs' => 0], self::NOW);

		$this->assertCount(1, $framesA, 'sender also receives the STATE');
		$this->assertCount(1, $framesB);
		$decoded = json_decode($framesB[0], true);
		$this->assertSame('STATE', $decoded['type']);
		$this->assertSame(PlaybackState::PLAYING, $decoded['playerState']);
		$this->assertSame(1, $decoded['eventId']);
	}

	public function testRateLimitRejectsBurstWithoutAffectingOthers(): void {
		[$runtime, $connA, $connB] = $this->setupTwoClients();
		$client = $runtime->getClient('A');
		// Drain the bucket.
		for ($i = 0; $i < 10; $i++) {
			$client->rateLimiter->tryConsume(self::NOW);
		}

		$ctx = new ConnectionContext(self::UUID);
		$ctx->joined = true;
		$ctx->clientId = 'A';

		$connB->expects($this->never())->method('send');
		$this->expectException(MessageException::class);
		$this->expectExceptionMessage('Too many control events');
		$this->handler->handle($connA, $ctx, ['event' => 'play', 'value' => null, 'clientTs' => 0], self::NOW);
	}

	public function testEventIdIncrementsMonotonicallyAcrossEvents(): void {
		[$runtime, $connA] = $this->setupTwoClients();

		$ctx = new ConnectionContext(self::UUID);
		$ctx->joined = true;
		$ctx->clientId = 'A';
		$connA->method('send');
		$this->registry->find(self::UUID)->getClient('B')->conn = null; // simplify broadcasts

		$this->handler->handle($connA, $ctx, ['event' => 'play', 'value' => null, 'clientTs' => 0], self::NOW);
		$this->handler->handle($connA, $ctx, ['event' => 'seek', 'value' => 30.0, 'clientTs' => 1], self::NOW + 100);
		$this->handler->handle($connA, $ctx, ['event' => 'pause', 'value' => null, 'clientTs' => 2], self::NOW + 200);

		$this->assertSame(3, $runtime->state->eventId);
		$this->assertCount(3, $runtime->recentEventsSince(0));
	}
}
