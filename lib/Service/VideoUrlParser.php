<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service;

use OCA\PlaybackSync\Service\Dto\ParsedVideo;

/**
 * Maps a public video URL to the `(providerId, videoId, pageUrl)` triple
 * that the playlist substrate uses as the natural entry key.
 *
 * First-class providers: YouTube (long, short, embed, shorts forms) and
 * Vimeo (numeric IDs). Anything else gets the `generic` fallback so a
 * single-mode room can still be created for sites we don't recognise —
 * the entry then has no scrape-friendly key, but `pageUrl` is enough for
 * the extension to navigate to.
 */
class VideoUrlParser {

	private const YOUTUBE_ID_PATTERN = '/^[A-Za-z0-9_\-]{11}$/';
	private const VIMEO_ID_PATTERN = '/^\d+$/';

	/**
	 * @return ParsedVideo|null `null` only when the input isn't a valid http(s) URL.
	 *                          Unrecognised hosts return a `generic`-provider entry.
	 */
	public function parse(string $pageUrl): ?ParsedVideo {
		$trimmed = trim($pageUrl);
		if ($trimmed === '') {
			return null;
		}

		$parts = parse_url($trimmed);
		if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
			return null;
		}
		$scheme = strtolower($parts['scheme']);
		if ($scheme !== 'http' && $scheme !== 'https') {
			return null;
		}

		$host = strtolower($parts['host']);
		$path = $parts['path'] ?? '';

		$youtubeId = $this->extractYoutubeId($host, $path, $parts['query'] ?? '');
		if ($youtubeId !== null) {
			return new ParsedVideo(
				providerId: 'youtube',
				videoId: $youtubeId,
				pageUrl: 'https://www.youtube.com/watch?v=' . $youtubeId,
			);
		}

		$vimeoId = $this->extractVimeoId($host, $path);
		if ($vimeoId !== null) {
			return new ParsedVideo(
				providerId: 'vimeo',
				videoId: $vimeoId,
				pageUrl: 'https://vimeo.com/' . $vimeoId,
			);
		}

		// Generic fallback: deterministic id from the URL so two callers
		// pasting the same link converge on the same entry key. 16 hex
		// chars is enough to collision-resist within a single playlist.
		return new ParsedVideo(
			providerId: 'generic',
			videoId: substr(sha1($trimmed), 0, 16),
			pageUrl: $trimmed,
		);
	}

	private function extractYoutubeId(string $host, string $path, string $query): ?string {
		$isYoutubeHost = $host === 'youtube.com'
			|| $host === 'www.youtube.com'
			|| $host === 'm.youtube.com'
			|| $host === 'music.youtube.com';
		$isShortHost = $host === 'youtu.be';

		if ($isYoutubeHost) {
			// /watch?v=ID
			if ($path === '/watch' && $query !== '') {
				parse_str($query, $params);
				$id = $params['v'] ?? null;
				if (is_string($id) && preg_match(self::YOUTUBE_ID_PATTERN, $id)) {
					return $id;
				}
			}
			// /embed/ID or /shorts/ID or /live/ID
			foreach (['/embed/', '/shorts/', '/live/'] as $prefix) {
				if (str_starts_with($path, $prefix)) {
					$id = substr($path, strlen($prefix));
					$id = explode('/', $id)[0];
					if (preg_match(self::YOUTUBE_ID_PATTERN, $id)) {
						return $id;
					}
				}
			}
		}

		if ($isShortHost && $path !== '' && $path !== '/') {
			$id = ltrim($path, '/');
			$id = explode('/', $id)[0];
			if (preg_match(self::YOUTUBE_ID_PATTERN, $id)) {
				return $id;
			}
		}

		return null;
	}

	private function extractVimeoId(string $host, string $path): ?string {
		if ($host !== 'vimeo.com' && $host !== 'www.vimeo.com' && $host !== 'player.vimeo.com') {
			return null;
		}
		// Either /<id> (vimeo.com) or /video/<id> (player.vimeo.com).
		$trimmed = ltrim($path, '/');
		if ($trimmed === '') {
			return null;
		}
		$segments = explode('/', $trimmed);
		$candidate = $segments[0] === 'video' && isset($segments[1]) ? $segments[1] : $segments[0];
		if (preg_match(self::VIMEO_ID_PATTERN, $candidate)) {
			return $candidate;
		}
		return null;
	}
}
