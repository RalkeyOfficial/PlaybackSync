<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket;

use OCA\PlaybackSync\WebSocket\ContentIdentity;
use PHPUnit\Framework\TestCase;

class ContentIdentityTest extends TestCase {

	public function testKeyIsDeterministicForSameInputs(): void {
		$a = new ContentIdentity('netflix', 'S01E01', 'https://example.com/watch/1');
		$b = new ContentIdentity('netflix', 'S01E01', 'https://example.com/watch/1');
		$this->assertSame($a->contentKey, $b->contentKey);
	}

	public function testProviderAndEpisodeAreCaseInsensitive(): void {
		$a = new ContentIdentity('Netflix', 's01e01', 'https://example.com/watch/1');
		$b = new ContentIdentity('NETFLIX', 'S01E01', 'https://example.com/watch/1');
		$this->assertSame($a->contentKey, $b->contentKey);
	}

	public function testPageUrlIsCaseSensitive(): void {
		// URL paths can be case-significant; we don't normalise that.
		$a = new ContentIdentity('netflix', 'S01E01', 'https://example.com/Watch/1');
		$b = new ContentIdentity('netflix', 'S01E01', 'https://example.com/watch/1');
		$this->assertNotSame($a->contentKey, $b->contentKey);
	}

	public function testMatchesAcceptsEquivalentInputs(): void {
		$id = new ContentIdentity('netflix', 'S01E01', 'https://example.com/watch/1');
		$this->assertTrue($id->matches('NETFLIX', 's01e01', 'https://example.com/watch/1'));
		$this->assertFalse($id->matches('hulu', 's01e01', 'https://example.com/watch/1'));
	}
}
