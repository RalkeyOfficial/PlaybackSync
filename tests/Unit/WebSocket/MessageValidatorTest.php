<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\MessageException;
use OCA\PlaybackSync\WebSocket\MessageValidator;
use PHPUnit\Framework\TestCase;

class MessageValidatorTest extends TestCase {

	private MessageValidator $v;

	protected function setUp(): void {
		parent::setUp();
		$this->v = new MessageValidator();
	}

	public function testParseRejectsMalformedJson(): void {
		$this->expectException(MessageException::class);
		$this->v->parse('{not json');
	}

	public function testParseRejectsMissingType(): void {
		$this->expectException(MessageException::class);
		$this->v->parse('{"foo": 1}');
	}

	public function testValidateJoinAcceptsMinimalPayload(): void {
		$out = $this->v->validateJoin(['type' => 'JOIN', 'password' => 'secret']);
		$this->assertSame('secret', $out['password']);
		$this->assertNull($out['clientId']);
		$this->assertNull($out['episodeId']);
	}

	public function testValidateJoinRequiresPassword(): void {
		$this->expectException(MessageException::class);
		$this->v->validateJoin(['type' => 'JOIN']);
	}

	public function testValidateJoinAcceptsAllContentIdentityFields(): void {
		$out = $this->v->validateJoin([
			'type' => 'JOIN',
			'password' => 'secret',
			'episodeId' => 'S01E01',
			'providerId' => 'netflix',
			'pageUrl' => 'https://example.com/watch/1',
		]);
		$this->assertSame('S01E01', $out['episodeId']);
		$this->assertSame('netflix', $out['providerId']);
	}

	public function testValidateJoinRejectsPartialContentIdentity(): void {
		$this->expectException(MessageException::class);
		$this->v->validateJoin([
			'type' => 'JOIN',
			'password' => 'secret',
			'episodeId' => 'S01E01',
		]);
	}

	public function testValidateEventRequiresValueForSeek(): void {
		$this->expectException(MessageException::class);
		$this->v->validateEvent(['type' => 'EVENT', 'event' => 'seek', 'clientTs' => 1000]);
	}

	public function testValidateEventAcceptsPlay(): void {
		$out = $this->v->validateEvent(['type' => 'EVENT', 'event' => 'play', 'clientTs' => 1000]);
		$this->assertSame('play', $out['event']);
		$this->assertNull($out['value']);
	}

	public function testValidateEventRejectsUnknownEvent(): void {
		$this->expectException(MessageException::class);
		$this->v->validateEvent(['type' => 'EVENT', 'event' => 'fastforward', 'clientTs' => 1000]);
	}

	public function testValidateHeartbeatAcceptsBuffering(): void {
		$out = $this->v->validateHeartbeat([
			'type' => 'HEARTBEAT',
			'currentPos' => 30,
			'playerState' => 'buffering',
		]);
		$this->assertSame(30.0, $out['currentPos']);
	}

	public function testValidateClockPingAcceptsNumericTime(): void {
		$out = $this->v->validateClockPing(['type' => 'CLOCK_PING', 'clientSendTime' => 12345.678]);
		$this->assertSame(12345.678, $out['clientSendTime']);
	}
}
