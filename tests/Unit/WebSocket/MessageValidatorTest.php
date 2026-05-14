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
		$this->assertNull($out['currentlyShowing']);
		$this->assertSame([], $out['catalogFragment']);
	}

	public function testValidateJoinRequiresPassword(): void {
		$this->expectException(MessageException::class);
		$this->v->validateJoin(['type' => 'JOIN']);
	}

	public function testValidateJoinAcceptsCurrentlyShowing(): void {
		$out = $this->v->validateJoin([
			'type' => 'JOIN',
			'password' => 'secret',
			'currentlyShowing' => [
				'providerId' => 'netflix',
				'videoId' => 'S01E01',
				'pageUrl' => 'https://example.com/watch/1',
			],
		]);
		$this->assertSame('S01E01', $out['currentlyShowing']['videoId']);
		$this->assertSame('netflix', $out['currentlyShowing']['providerId']);
	}

	public function testValidateJoinAcceptsCatalogFragment(): void {
		$out = $this->v->validateJoin([
			'type' => 'JOIN',
			'password' => 'secret',
			'catalogFragment' => [
				[
					'providerId' => 'netflix',
					'videoId' => 'S01E01',
					'pageUrl' => 'https://example.com/watch/1',
					'label' => 'Episode 1',
					'episodeNumber' => 1,
					'seasonNumber' => 1,
				],
			],
		]);
		$this->assertCount(1, $out['catalogFragment']);
		$this->assertSame('Episode 1', $out['catalogFragment'][0]['label']);
	}

	public function testValidateJoinRejectsPartialCurrentlyShowing(): void {
		$this->expectException(MessageException::class);
		$this->v->validateJoin([
			'type' => 'JOIN',
			'password' => 'secret',
			'currentlyShowing' => ['providerId' => 'netflix'],
		]);
	}

	public function testValidateCursorChangeRequiresEntryOrTarget(): void {
		$this->expectException(MessageException::class);
		$this->v->validateCursorChangeRequest(['type' => 'CURSOR_CHANGE_REQUEST', 'clientTs' => 1]);
	}

	public function testValidateCursorChangeAcceptsEntryId(): void {
		$out = $this->v->validateCursorChangeRequest([
			'type' => 'CURSOR_CHANGE_REQUEST',
			'targetEntryId' => 'e_01',
			'clientTs' => 1,
		]);
		$this->assertSame('e_01', $out['targetEntryId']);
		$this->assertNull($out['target']);
	}

	public function testValidateCursorChangeAcceptsRawTarget(): void {
		$out = $this->v->validateCursorChangeRequest([
			'type' => 'CURSOR_CHANGE_REQUEST',
			'target' => [
				'providerId' => 'youtube',
				'videoId' => 'abc',
				'pageUrl' => 'https://yt/watch?v=abc',
			],
			'clientTs' => 1,
		]);
		$this->assertNull($out['targetEntryId']);
		$this->assertSame('abc', $out['target']['videoId']);
	}

	public function testValidateCursorChangeRejectsBothFormsAtOnce(): void {
		$this->expectException(MessageException::class);
		$this->v->validateCursorChangeRequest([
			'type' => 'CURSOR_CHANGE_REQUEST',
			'targetEntryId' => 'e_01',
			'target' => ['providerId' => 'a', 'videoId' => 'b', 'pageUrl' => 'c'],
			'clientTs' => 1,
		]);
	}

	public function testValidatePlaylistUpdateRequiresNonEmptyEntries(): void {
		$this->expectException(MessageException::class);
		$this->v->validatePlaylistUpdate(['type' => 'PLAYLIST_UPDATE', 'entries' => [], 'clientTs' => 1]);
	}

	public function testValidatePlaylistUpdateAcceptsScrapedEntries(): void {
		$out = $this->v->validatePlaylistUpdate([
			'type' => 'PLAYLIST_UPDATE',
			'entries' => [
				[
					'providerId' => 'cr',
					'videoId' => 'ep01',
					'pageUrl' => 'https://cr/ep01',
					'source' => 'scraped',
				],
			],
			'clientTs' => 1,
		]);
		$this->assertCount(1, $out['entries']);
		$this->assertSame('scraped', $out['entries'][0]['source']);
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
