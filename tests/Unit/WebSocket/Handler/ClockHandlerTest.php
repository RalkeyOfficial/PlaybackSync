<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Handler;

use OCA\PlaybackSync\WebSocket\ConnectionContext;
use OCA\PlaybackSync\WebSocket\Handler\ClockHandler;
use OCA\PlaybackSync\WebSocket\MessageEncoder;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;

class ClockHandlerTest extends TestCase {

	public function testPongCarriesAllFourTimestamps(): void {
		$handler = new ClockHandler(new MessageEncoder());
		$conn = $this->createMock(ConnectionInterface::class);
		$captured = null;
		$conn->expects($this->once())->method('send')
			->willReturnCallback(function (string $f) use (&$captured): void { $captured = $f; });

		$handler->handle($conn, new ConnectionContext('11111111-1111-4111-9111-111111111111'), [
			'clientSendTime' => 12345.678,
		], 999);

		$decoded = json_decode($captured, true);
		$this->assertSame('CLOCK_PONG', $decoded['type']);
		$this->assertSame(12345.678, $decoded['clientSendTime']);
		$this->assertSame(999, $decoded['serverRecvTime']);
		$this->assertGreaterThanOrEqual(999, $decoded['serverSendTime']);
	}
}
