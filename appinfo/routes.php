<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

		['name' => 'room#index', 'url' => '/api/v1/rooms', 'verb' => 'GET'],
		['name' => 'room#create', 'url' => '/api/v1/rooms', 'verb' => 'POST'],
		['name' => 'room#show', 'url' => '/api/v1/rooms/{uuid}', 'verb' => 'GET'],
		['name' => 'room#destroy', 'url' => '/api/v1/rooms/{uuid}', 'verb' => 'DELETE'],

		['name' => 'ws_status#index', 'url' => '/api/v1/ws/status', 'verb' => 'GET'],
	],
];
