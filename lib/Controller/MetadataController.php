<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCA\PlaybackSync\Service\OembedLookupService;
use OCA\PlaybackSync\Service\VideoUrlParser;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;

/**
 * Side-channel metadata endpoints used by the dashboard. Right now: a
 * single URL → `{providerId, videoId, pageUrl, label, providerName}`
 * lookup the create dialog calls when the owner pastes a video URL for
 * a single-mode room.
 *
 * Kept distinct from `RoomController` because it doesn't touch rooms —
 * it only resolves URL → provider identity and best-effort title.
 */
class MetadataController extends Controller {

	public function __construct(
		string $appName,
		IRequest $request,
		private ?string $userId,
		private VideoUrlParser $parser,
		private OembedLookupService $oembed,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * Resolve a pasted page URL.
	 *
	 * Returns `unsupported_url` if the input isn't a valid http(s) URL.
	 * Returns HTTP 200 with `label: null` when the URL parsed but the
	 * oEmbed lookup didn't yield a title — the dialog renders that as
	 * "Title not found, will use URL" and the entry is still submittable.
	 *
	 * @param string $pageUrl The video page URL the owner pasted.
	 */
	#[NoAdminRequired]
	public function lookup(string $pageUrl): DataResponse {
		if ($this->userId === null) {
			return new DataResponse(['error' => 'Authentication required.'], Http::STATUS_UNAUTHORIZED);
		}

		$parsed = $this->parser->parse($pageUrl);
		if ($parsed === null) {
			return new DataResponse(
				['error' => 'pageUrl must be a valid http(s) URL', 'code' => 'unsupported_url'],
				Http::STATUS_BAD_REQUEST,
			);
		}

		$lookup = $this->oembed->fetch($parsed->pageUrl, $parsed->providerId);

		return new DataResponse([
			'providerId' => $parsed->providerId,
			'videoId' => $parsed->videoId,
			'pageUrl' => $parsed->pageUrl,
			'label' => $lookup['title'] ?? null,
			'providerName' => $lookup['providerName'] ?? null,
			'thumbnailUrl' => $lookup['thumbnailUrl'] ?? null,
		]);
	}
}
