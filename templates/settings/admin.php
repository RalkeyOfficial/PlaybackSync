<?php

declare(strict_types=1);

use OCA\PlaybackSync\AppInfo\Application;
use OCP\Util;

$appId = Application::APP_ID;
Util::addScript($appId, $appId . '-adminSettings');
?>
<div id="playbacksync-admin-settings"></div>
