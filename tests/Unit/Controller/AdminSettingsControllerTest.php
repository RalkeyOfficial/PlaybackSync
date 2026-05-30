<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Controller\AdminSettingsController;
use OCA\PlaybackSync\Service\AdminEventClient;
use OCA\PlaybackSync\Service\AdminReloadClient;
use OCA\PlaybackSync\Service\AdminRestartClient;
use OCA\PlaybackSync\Service\AdminSecretService;
use OCA\PlaybackSync\Service\Exceptions\DaemonReloadFailedException;
use OCA\PlaybackSync\Service\Exceptions\DaemonRestartFailedException;
use OCA\PlaybackSync\Settings\SettingsDefaults;
use OCP\AppFramework\Http;
use OCP\IAppConfig;
use OCP\IRequest;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class AdminSettingsControllerTest extends TestCase {

	private IRequest&MockObject $request;
	private IAppConfig&MockObject $appConfig;
	private AdminSecretService&MockObject $secrets;
	private AdminEventClient&MockObject $eventClient;
	private AdminRestartClient&MockObject $restartClient;
	private AdminReloadClient&MockObject $reloadClient;
	private AdminSettingsController $controller;

	/**
	 * In-memory shadow of IAppConfig used by `stubStore()`. The key prefix
	 * indicates the typed setter the production code would have written it
	 * through: `int:ws_port`, `string:ws_host`, `bool:restrict_to_admins`.
	 *
	 * @var array<string, int|string|bool>
	 */
	private array $store = [];

	protected function setUp(): void {
		parent::setUp();
		$this->request = $this->createMock(IRequest::class);
		$this->appConfig = $this->createMock(IAppConfig::class);
		$this->secrets = $this->createMock(AdminSecretService::class);
		$this->eventClient = $this->createMock(AdminEventClient::class);
		$this->restartClient = $this->createMock(AdminRestartClient::class);
		$this->reloadClient = $this->createMock(AdminReloadClient::class);

		$this->secrets->method('peekMasked')->willReturn([
			'configured' => true,
			'masked' => 'abcd…wxyz',
			'length' => 64,
		]);

		$this->controller = new AdminSettingsController(
			Application::APP_ID,
			$this->request,
			'admin',
			$this->appConfig,
			$this->secrets,
			$this->eventClient,
			$this->restartClient,
			$this->reloadClient,
		);
	}

	public function testSnapshotReturnsNullForKeysNeverWritten(): void {
		// hasKey returns false for everything → no keys are present.
		$this->appConfig->method('hasKey')->willReturn(false);
		// The controller must not even call the typed getters when a key is
		// absent — that would smuggle in IAppConfig's own default value.
		$this->appConfig->expects($this->never())->method('getValueInt');
		$this->appConfig->expects($this->never())->method('getValueString');
		$this->appConfig->expects($this->never())->method('getValueBool');

		$response = $this->controller->index();
		$data = $response->getData();

		foreach ($data['wsTuning'] as $value) {
			$this->assertNull($value);
		}
		$this->assertNull($data['daemon']['ws_host']);
		$this->assertNull($data['daemon']['ws_port']);
		$this->assertNull($data['daemon']['ws_admin_host']);
		$this->assertNull($data['daemon']['ws_admin_port']);
		$this->assertNull($data['rooms']['restrict_to_admins']);
		$this->assertNull($data['rooms']['default_ttl_seconds']);
		$this->assertNull($data['rooms']['max_ttl_seconds']);
		$this->assertNull($data['rooms']['max_clients_per_room']);
	}

	public function testSnapshotMirrorsPersistedValues(): void {
		$this->stubStore([
			'int:ws_port' => 9000,
			'int:ws_admin_port' => 9001,
			'int:ws_join_timeout_ms' => 7_500,
			'int:ws_idle_close_ms' => 45_000,
			'int:ws_tombstone_ms' => 60_000,
			'int:ws_kick_block_ms' => 90_000,
			'int:ws_event_log_size' => 500,
			'int:ws_rate_limit_events_per_sec' => 20,
			'int:ws_drift_nudge_threshold_ms' => 250,
			'int:ws_drift_seek_threshold_ms' => 750,
			'int:ws_drift_cooldown_ms' => 4_000,
			'int:default_ttl_seconds' => 3_600,
			'int:max_ttl_seconds' => 7_200,
			'int:max_clients_per_room' => 12,
			'string:ws_host' => '10.0.0.1',
			'string:ws_admin_host' => '10.0.0.2',
			'bool:restrict_to_admins' => true,
		]);

		$data = $this->controller->index()->getData();

		$this->assertSame(9000, $data['daemon']['ws_port']);
		$this->assertSame('10.0.0.1', $data['daemon']['ws_host']);
		$this->assertSame(9001, $data['daemon']['ws_admin_port']);
		$this->assertSame('10.0.0.2', $data['daemon']['ws_admin_host']);
		$this->assertTrue($data['rooms']['restrict_to_admins']);
		$this->assertSame(3_600, $data['rooms']['default_ttl_seconds']);
		$this->assertSame(7_200, $data['rooms']['max_ttl_seconds']);
		$this->assertSame(12, $data['rooms']['max_clients_per_room']);
		$this->assertSame(7_500, $data['wsTuning']['ws_join_timeout_ms']);
	}

	public function testSnapshotMixesPersistedValuesWithNullsForMissingKeys(): void {
		// Only ws_port saved; every other key is "never written" — so the
		// daemon section should carry one int and three nulls.
		$this->stubStore(['int:ws_port' => 8765]);

		$data = $this->controller->index()->getData();

		$this->assertSame(8765, $data['daemon']['ws_port']);
		$this->assertNull($data['daemon']['ws_host']);
		$this->assertNull($data['daemon']['ws_admin_host']);
		$this->assertNull($data['daemon']['ws_admin_port']);
	}

	public function testUpdateRejectsUnknownKeys(): void {
		$this->appConfig->expects($this->never())->method('setValueInt');

		$response = $this->controller->update(['totally_made_up_key' => 1]);

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
		$this->assertArrayHasKey('error', $response->getData());
	}

	public function testUpdateRejectsOutOfRangeInteger(): void {
		$this->appConfig->expects($this->never())->method('setValueInt');

		$response = $this->controller->update(['ws_port' => 70_000]);

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
	}

	public function testUpdatePersistsValidPatchAndReturnsFreshSnapshot(): void {
		$this->stubStore([
			'int:ws_port' => 8765,
			'int:max_ttl_seconds' => SettingsDefaults::INT_DEFAULTS['max_ttl_seconds'],
			'int:default_ttl_seconds' => SettingsDefaults::INT_DEFAULTS['default_ttl_seconds'],
		]);

		// Capture the value that gets persisted and reflect it back through
		// the shadow store so the post-update snapshot reads the new number.
		$this->appConfig->method('setValueInt')
			->willReturnCallback(function (string $app, string $key, int $value): bool {
				$this->store['int:' . $key] = $value;
				return true;
			});

		$this->eventClient->expects($this->once())
			->method('record')
			->with('settings_updated', 'admin', 'admin', 'admin', null, $this->callback(function (array $payload): bool {
				$this->assertArrayHasKey('changes', $payload);
				$this->assertSame([
					['key' => 'ws_port', 'from' => 8765, 'to' => 9100],
				], $payload['changes']);
				return true;
			}));

		$response = $this->controller->update(['ws_port' => 9100]);

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertSame(9100, $response->getData()['daemon']['ws_port']);
	}

	public function testRestartDaemonReturnsInitiatedWhenAccepted(): void {
		$this->restartClient->expects($this->once())->method('restart');

		$response = $this->controller->restartDaemon();

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertSame(['status' => 'restart_initiated'], $response->getData());
	}

	public function testRestartDaemonMapsFailureToBadGateway(): void {
		$this->restartClient->method('restart')
			->willThrowException(new DaemonRestartFailedException('WebSocket daemon unreachable.'));

		$response = $this->controller->restartDaemon();

		$this->assertSame(Http::STATUS_BAD_GATEWAY, $response->getStatus());
		$this->assertArrayHasKey('error', $response->getData());
	}

	public function testReloadDaemonReturnsChangedAndRecordsEvent(): void {
		$changed = ['driftNudgeThresholdMs' => ['from' => 200, 'to' => 400]];
		$this->reloadClient->method('reload')->willReturn($changed);
		$this->eventClient->expects($this->once())
			->method('record')
			->with('daemon_config_reloaded', 'admin', 'admin', 'admin', null, ['changed' => ['driftNudgeThresholdMs']]);

		$response = $this->controller->reloadDaemon();

		$this->assertSame(Http::STATUS_OK, $response->getStatus());
		$this->assertSame(['status' => 'reloaded', 'changed' => $changed], $response->getData());
	}

	public function testReloadDaemonMapsFailureToBadGateway(): void {
		$this->reloadClient->method('reload')
			->willThrowException(new DaemonReloadFailedException('WebSocket daemon unreachable.'));
		$this->eventClient->expects($this->never())->method('record');

		$response = $this->controller->reloadDaemon();

		$this->assertSame(Http::STATUS_BAD_GATEWAY, $response->getStatus());
		$this->assertArrayHasKey('error', $response->getData());
	}

	/**
	 * Configure the IAppConfig mock to behave like an in-memory key-value
	 * store. Keys passed in `$initial` are pre-seeded; any subsequent read
	 * uses `hasKey()` for presence and the typed getters for values.
	 *
	 * @param array<string, int|string|bool> $initial mapping of `type:key` → value
	 */
	private function stubStore(array $initial): void {
		$this->store = $initial;

		$this->appConfig->method('hasKey')
			->willReturnCallback(function (string $app, string $key): bool {
				return isset($this->store['int:' . $key])
					|| isset($this->store['string:' . $key])
					|| isset($this->store['bool:' . $key]);
			});

		$this->appConfig->method('getValueInt')
			->willReturnCallback(function (string $app, string $key, int $default = 0): int {
				return $this->store['int:' . $key] ?? $default;
			});

		$this->appConfig->method('getValueString')
			->willReturnCallback(function (string $app, string $key, string $default = ''): string {
				return $this->store['string:' . $key] ?? $default;
			});

		$this->appConfig->method('getValueBool')
			->willReturnCallback(function (string $app, string $key, bool $default = false): bool {
				return $this->store['bool:' . $key] ?? $default;
			});
	}
}
