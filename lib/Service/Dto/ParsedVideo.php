<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Dto;

/**
 * Result of `VideoUrlParser::parse`: enough to construct a playlist entry's
 * natural key (`providerId` + `videoId`) plus the URL the extension should
 * navigate to. `pageUrl` is the parser's normalised form — for YouTube short
 * (`youtu.be/<id>`) and embed (`youtube.com/embed/<id>`) variants, that's the
 * canonical `watch?v=<id>` page so all callers converge on the same wire
 * representation regardless of the input shape.
 */
final class ParsedVideo {

	public function __construct(
		public readonly string $providerId,
		public readonly string $videoId,
		public readonly string $pageUrl,
	) {
	}
}
