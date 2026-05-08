<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use OCP\Util;

class PageController extends Controller {
	public function __construct(string $appName, IRequest $request) {
		parent::__construct($appName, $request);
	}

	/**
	 * @NoCSRFRequired
	 * @NoAdminRequired
	 */
	public function index(): TemplateResponse {
		Util::addScript('playbacksync', 'playbacksync-main');
		return new TemplateResponse('playbacksync', 'index');
	}
}
