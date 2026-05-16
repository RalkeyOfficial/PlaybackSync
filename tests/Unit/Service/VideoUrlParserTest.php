<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Service;

use OCA\PlaybackSync\Service\VideoUrlParser;
use PHPUnit\Framework\TestCase;

class VideoUrlParserTest extends TestCase {

	private VideoUrlParser $subject;

	protected function setUp(): void {
		parent::setUp();
		$this->subject = new VideoUrlParser();
	}

	/**
	 * @dataProvider youtubeUrlProvider
	 */
	public function testParsesYouTubeUrls(string $input, string $expectedId): void {
		$result = $this->subject->parse($input);

		$this->assertNotNull($result);
		$this->assertSame('youtube', $result->providerId);
		$this->assertSame($expectedId, $result->videoId);
		$this->assertSame('https://www.youtube.com/watch?v=' . $expectedId, $result->pageUrl);
	}

	/**
	 * @return list<array{string, string}>
	 */
	public static function youtubeUrlProvider(): array {
		return [
			'long form'              => ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
			'long form no www'       => ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
			'mobile host'            => ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
			'music host'             => ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
			'long form with extras'  => ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RD123&t=42s', 'dQw4w9WgXcQ'],
			'short form'             => ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
			'short form with query'  => ['https://youtu.be/dQw4w9WgXcQ?t=42s', 'dQw4w9WgXcQ'],
			'embed'                  => ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
			'embed with trailing'    => ['https://www.youtube.com/embed/dQw4w9WgXcQ/extra', 'dQw4w9WgXcQ'],
			'shorts'                 => ['https://www.youtube.com/shorts/aZ_-0_19ab1', 'aZ_-0_19ab1'],
			'live'                   => ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
			'underscore + dash id'   => ['https://www.youtube.com/watch?v=a_-bcDEF1_2', 'a_-bcDEF1_2'],
		];
	}

	/**
	 * @dataProvider vimeoUrlProvider
	 */
	public function testParsesVimeoUrls(string $input, string $expectedId): void {
		$result = $this->subject->parse($input);

		$this->assertNotNull($result);
		$this->assertSame('vimeo', $result->providerId);
		$this->assertSame($expectedId, $result->videoId);
		$this->assertSame('https://vimeo.com/' . $expectedId, $result->pageUrl);
	}

	/**
	 * @return list<array{string, string}>
	 */
	public static function vimeoUrlProvider(): array {
		return [
			'numeric path'        => ['https://vimeo.com/123456789', '123456789'],
			'with www'            => ['https://www.vimeo.com/123456789', '123456789'],
			'player embed'        => ['https://player.vimeo.com/video/987654321', '987654321'],
			'trailing slash'      => ['https://vimeo.com/123456789/', '123456789'],
		];
	}

	public function testFallsBackToGenericForUnknownHosts(): void {
		$url = 'https://example.com/some/page?id=abc';
		$result = $this->subject->parse($url);

		$this->assertNotNull($result);
		$this->assertSame('generic', $result->providerId);
		$this->assertSame($url, $result->pageUrl);
		$this->assertSame(16, strlen($result->videoId));
		// Deterministic — same URL always hashes the same way.
		$this->assertSame($result->videoId, $this->subject->parse($url)?->videoId);
	}

	public function testFallsBackToGenericForYouTubeUrlWithBadId(): void {
		// `v=` parameter is present but the id isn't 11 chars of [A-Za-z0-9_-].
		$result = $this->subject->parse('https://www.youtube.com/watch?v=tooshort');

		$this->assertNotNull($result);
		$this->assertSame('generic', $result->providerId);
	}

	public function testFallsBackToGenericForVimeoNonNumericPath(): void {
		$result = $this->subject->parse('https://vimeo.com/staff-picks');

		$this->assertNotNull($result);
		$this->assertSame('generic', $result->providerId);
	}

	/**
	 * @dataProvider invalidInputProvider
	 */
	public function testRejectsInvalidInput(string $input): void {
		$this->assertNull($this->subject->parse($input));
	}

	/**
	 * @return list<array{string}>
	 */
	public static function invalidInputProvider(): array {
		return [
			'empty'           => [''],
			'whitespace only' => ['   '],
			'no scheme'       => ['www.youtube.com/watch?v=dQw4w9WgXcQ'],
			'ftp scheme'      => ['ftp://example.com/video.mp4'],
			'javascript'      => ['javascript:alert(1)'],
			'no host'         => ['https:///path'],
			'malformed'       => ['ht!tp://broken'],
		];
	}

	public function testTrimsWhitespace(): void {
		$result = $this->subject->parse('  https://youtu.be/dQw4w9WgXcQ  ');

		$this->assertNotNull($result);
		$this->assertSame('youtube', $result->providerId);
		$this->assertSame('dQw4w9WgXcQ', $result->videoId);
	}
}
