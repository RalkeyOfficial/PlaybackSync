<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

		['name' => 'share#show', 'url' => '/r/{uuid}', 'verb' => 'GET'],

		['name' => 'room#index', 'url' => '/api/v1/rooms', 'verb' => 'GET'],
		['name' => 'room#create', 'url' => '/api/v1/rooms', 'verb' => 'POST'],
		['name' => 'room#show', 'url' => '/api/v1/rooms/{uuid}', 'verb' => 'GET'],
		['name' => 'room#clients', 'url' => '/api/v1/rooms/{uuid}/clients', 'verb' => 'GET'],
		['name' => 'room#kickClient', 'url' => '/api/v1/rooms/{uuid}/clients/{clientId}', 'verb' => 'DELETE'],
		['name' => 'room#playback', 'url' => '/api/v1/rooms/{uuid}/playback', 'verb' => 'POST'],
		['name' => 'room#settings', 'url' => '/api/v1/rooms/{uuid}/settings', 'verb' => 'POST'],
		['name' => 'room#addPlaylistEntry', 'url' => '/api/v1/rooms/{uuid}/playlist/entries', 'verb' => 'POST'],
		['name' => 'room#updatePlaylistEntry', 'url' => '/api/v1/rooms/{uuid}/playlist/entries/{entryId}', 'verb' => 'PATCH'],
		['name' => 'room#removePlaylistEntry', 'url' => '/api/v1/rooms/{uuid}/playlist/entries/{entryId}', 'verb' => 'DELETE'],
		['name' => 'room#clearPlaylist', 'url' => '/api/v1/rooms/{uuid}/playlist', 'verb' => 'DELETE'],
		['name' => 'room#setCursor', 'url' => '/api/v1/rooms/{uuid}/cursor', 'verb' => 'POST'],
		['name' => 'room#playlist', 'url' => '/api/v1/rooms/{uuid}/playlist', 'verb' => 'GET'],
		['name' => 'room#eventsStream', 'url' => '/api/v1/rooms/{uuid}/events/stream', 'verb' => 'GET'],
		['name' => 'room#destroy', 'url' => '/api/v1/rooms/{uuid}', 'verb' => 'DELETE'],

		['name' => 'ws_status#index', 'url' => '/api/v1/ws/status', 'verb' => 'GET'],

		['name' => 'health#index', 'url' => '/api/v1/health', 'verb' => 'GET'],

		['name' => 'metadata#lookup', 'url' => '/api/v1/metadata/lookup', 'verb' => 'POST'],

		['name' => 'admin_settings#index', 'url' => '/api/v1/admin/settings', 'verb' => 'GET'],
		['name' => 'admin_settings#update', 'url' => '/api/v1/admin/settings', 'verb' => 'PUT'],
		['name' => 'admin_settings#regenerateAdminSecret', 'url' => '/api/v1/admin/settings/secret', 'verb' => 'POST'],
		['name' => 'admin_settings#eventsStream', 'url' => '/api/v1/admin/events/stream', 'verb' => 'GET'],

		['name' => 'user_settings#index', 'url' => '/api/v1/user/settings', 'verb' => 'GET'],
		['name' => 'user_settings#update', 'url' => '/api/v1/user/settings', 'verb' => 'PUT'],
	],
];
