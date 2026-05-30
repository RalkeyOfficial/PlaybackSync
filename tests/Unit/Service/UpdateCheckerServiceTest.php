<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\UpdateCheckerService;
use OCP\App\IAppManager;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Http\Client\IClient;
use OCP\Http\Client\IClientService;
use OCP\Http\Client\IResponse;
use OCP\IAppConfig;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;
use RuntimeException;

class UpdateCheckerServiceTest extends TestCase {

	private IClientService&MockObject $clientService;
	private IClient&MockObject $httpClient;
	private IAppConfig&MockObject $appConfig;
	private IAppManager&MockObject $appManager;
	private ITimeFactory&MockObject $time;
	private LoggerInterface&MockObject $logger;
	private UpdateCheckerService $subject;

	private string $installedVersion = '1.0.0';

	/**
	 * In-memory IAppConfig shadow keyed by `type:key` (e.g. `string:update_latest_version`),
	 * so the test can assert what `check()` persisted and feed it back to `status()`.
	 *
	 * @var array<string, int|string|bool>
	 */
	private array $store = [];

	protected function setUp(): void {
		parent::setUp();
		$this->clientService = $this->createMock(IClientService::class);
		$this->httpClient = $this->createMock(IClient::class);
		$this->appConfig = $this->createMock(IAppConfig::class);
		$this->appManager = $this->createMock(IAppManager::class);
		$this->time = $this->createMock(ITimeFactory::class);
		$this->logger = $this->createMock(LoggerInterface::class);

		$this->clientService->method('newClient')->willReturn($this->httpClient);
		$this->appManager->method('getAppVersion')->willReturnCallback(
			fn (): string => $this->installedVersion,
		);
		$this->time->method('getTime')->willReturn(1_700_000_000);

		$this->appConfig->method('getValueString')->willReturnCallback(
			fn (string $app, string $key, string $default = ''): string => $app === Application::APP_ID
				? (string)($this->store['string:' . $key] ?? $default)
				: $default,
		);
		$this->appConfig->method('getValueInt')->willReturnCallback(
			fn (string $app, string $key, int $default = 0): int => $app === Application::APP_ID
				? (int)($this->store['int:' . $key] ?? $default)
				: $default,
		);
		$this->appConfig->method('getValueBool')->willReturnCallback(
			fn (string $app, string $key, bool $default = false): bool => $app === Application::APP_ID
				? (bool)($this->store['bool:' . $key] ?? $default)
				: $default,
		);
		$this->appConfig->method('setValueString')->willReturnCallback(
			function (string $app, string $key, string $value): bool {
				$this->store['string:' . $key] = $value;
				return true;
			},
		);
		$this->appConfig->method('setValueInt')->willReturnCallback(
			function (string $app, string $key, int $value): bool {
				$this->store['int:' . $key] = $value;
				return true;
			},
		);

		$this->subject = new UpdateCheckerService(
			$this->clientService,
			$this->appConfig,
			$this->appManager,
			$this->time,
			$this->logger,
		);
	}

	public function testStatusIsUpToDateWithNoCachedVersion(): void {
		$status = $this->subject->status();

		$this->assertSame('1.0.0', $status['currentVersion']);
		$this->assertNull($status['latestVersion']);
		$this->assertFalse($status['updateAvailable']);
		$this->assertNull($status['lastCheckedAt']);
		// Falls back to the releases page when no release URL has been cached.
		$this->assertStringContainsString('/releases', $status['releaseUrl']);
		// Defaults to enabled when the toggle was never written.
		$this->assertTrue($status['enabled']);
	}

	public function testCheckPersistsNewerVersionAndFlagsUpdate(): void {
		$this->stubResponse(200, json_encode([
			'tag_name' => 'v1.2.0',
			'html_url' => 'https://github.com/RalkeyOfficial/PlaybackSync/releases/tag/v1.2.0',
		]));

		$status = $this->subject->check();

		$this->assertTrue($status['updateAvailable']);
		$this->assertSame('1.2.0', $status['latestVersion']);
		$this->assertSame('https://github.com/RalkeyOfficial/PlaybackSync/releases/tag/v1.2.0', $status['releaseUrl']);
		$this->assertSame(1_700_000_000, $status['lastCheckedAt']);
		// The normalized (v-stripped) version is what gets persisted.
		$this->assertSame('1.2.0', $this->store['string:update_latest_version']);
	}

	public function testCheckReportsUpToDateWhenLatestEqualsInstalled(): void {
		$this->stubResponse(200, json_encode(['tag_name' => '1.0.0']));

		$status = $this->subject->check();

		$this->assertFalse($status['updateAvailable']);
		$this->assertSame('1.0.0', $status['latestVersion']);
	}

	public function testCheckDoesNotFlagUpdateForOlderPublishedTag(): void {
		$this->installedVersion = '2.0.0';
		$this->stubResponse(200, json_encode(['tag_name' => 'v1.9.9']));

		$status = $this->subject->check();

		$this->assertFalse($status['updateAvailable']);
		$this->assertSame('1.9.9', $status['latestVersion']);
	}

	public function testCheckGracefullyHandlesNon200(): void {
		$this->stubResponse(403, '{"message":"rate limit"}');
		$this->logger->expects($this->once())->method('warning');

		$status = $this->subject->check();

		$this->assertNull($status['latestVersion']);
		$this->assertArrayNotHasKey('string:update_latest_version', $this->store);
	}

	public function testCheckGracefullyHandlesMalformedJson(): void {
		$this->stubResponse(200, 'not json');
		$this->logger->expects($this->once())->method('warning');

		$status = $this->subject->check();

		$this->assertNull($status['latestVersion']);
		$this->assertArrayNotHasKey('int:update_last_checked_at', $this->store);
	}

	public function testCheckGracefullyHandlesTransportFailure(): void {
		$this->httpClient->method('get')->willThrowException(new RuntimeException('connect timeout'));
		$this->logger->expects($this->once())->method('warning');

		$status = $this->subject->check();

		$this->assertNull($status['latestVersion']);
	}

	public function testStatusReflectsDisabledToggle(): void {
		$this->store['bool:update_check_enabled'] = false;

		$this->assertFalse($this->subject->status()['enabled']);
	}

	private function stubResponse(int $status, string $body): void {
		$response = $this->createMock(IResponse::class);
		$response->method('getStatusCode')->willReturn($status);
		$response->method('getBody')->willReturn($body);
		$this->httpClient->method('get')->willReturn($response);
	}
}
