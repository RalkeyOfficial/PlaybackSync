<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Service;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Service\PresenceClient;
use OCP\Http\Client\IClient;
use OCP\Http\Client\IClientService;
use OCP\Http\Client\IResponse;
use OCP\IAppConfig;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;
use RuntimeException;

class PresenceClientTest extends TestCase {

	private IClientService&MockObject $clientService;
	private IClient&MockObject $httpClient;
	private IAppConfig&MockObject $appConfig;
	private LoggerInterface&MockObject $logger;
	private PresenceClient $subject;
	private string $secret = 'test-secret';

	protected function setUp(): void {
		parent::setUp();
		$this->clientService = $this->createMock(IClientService::class);
		$this->httpClient = $this->createMock(IClient::class);
		$this->appConfig = $this->createMock(IAppConfig::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->clientService->method('newClient')->willReturn($this->httpClient);

		// Closures read the live `$this->secret` so individual tests can flip
		// it before exercising the subject.
		$this->appConfig->method('getValueString')->willReturnCallback(
			function (string $app, string $key, string $default = ''): string {
				if ($app !== Application::APP_ID) {
					return $default;
				}
				return match ($key) {
					'ws_admin_secret' => $this->secret,
					'ws_admin_host' => '127.0.0.1',
					default => $default,
				};
			},
		);
		$this->appConfig->method('getValueInt')->willReturnCallback(
			static fn (string $app, string $key, int $default = 0): int => $default,
		);

		$this->subject = new PresenceClient($this->clientService, $this->appConfig, $this->logger);
	}

	public function testReturnsEmptyMapForEmptyUuidList(): void {
		$this->httpClient->expects($this->never())->method('get');
		$this->assertSame([], $this->subject->fetch([]));
	}

	public function testReturnsEmptyMapWhenSecretMissing(): void {
		$this->secret = '';
		$this->httpClient->expects($this->never())->method('get');

		$this->assertSame([], $this->subject->fetch(['11111111-1111-1111-1111-111111111111']));
	}

	public function testParsesSuccessfulResponse(): void {
		$body = json_encode([
			'rooms' => [
				'11111111-1111-1111-1111-111111111111' => [
					'connectedCount' => 2,
					'clients' => [
						['clientId' => 'alice', 'isBuffering' => false, 'lastSeenMs' => 1_700_000_001_000],
						['clientId' => 'bob',   'isBuffering' => true,  'lastSeenMs' => 1_700_000_002_000],
					],
					'playerState' => 'playing',
					'videoPos' => 42.71,
					'lastActivityMs' => 1_700_000_002_000,
				],
			],
		]);

		$this->stubResponse(status: 200, body: $body);

		$result = $this->subject->fetch(['11111111-1111-1111-1111-111111111111']);
		$this->assertCount(1, $result);
		$dto = $result['11111111-1111-1111-1111-111111111111'];
		$this->assertSame(2, $dto->connectedCount);
		$this->assertSame('playing', $dto->playerState);
		$this->assertSame(42.71, $dto->videoPos);
		$this->assertSame(1_700_000_002_000, $dto->lastActivityMs);
	}

	public function testGracefullyHandlesNon200Status(): void {
		$this->stubResponse(status: 401, body: '{"error":"unauthorized"}');
		$this->logger->expects($this->once())->method('warning');

		$this->assertSame([], $this->subject->fetch(['11111111-1111-1111-1111-111111111111']));
	}

	public function testGracefullyHandlesTimeout(): void {
		$this->httpClient->method('get')->willThrowException(new RuntimeException('connect timeout'));
		$this->logger->expects($this->once())->method('warning');

		$this->assertSame([], $this->subject->fetch(['11111111-1111-1111-1111-111111111111']));
	}

	public function testGracefullyHandlesMalformedJson(): void {
		$this->stubResponse(status: 200, body: 'not json at all');
		$this->logger->expects($this->once())->method('warning');

		$this->assertSame([], $this->subject->fetch(['11111111-1111-1111-1111-111111111111']));
	}

	public function testGracefullyHandlesMissingRoomsKey(): void {
		$this->stubResponse(status: 200, body: '{"unexpected":true}');
		$this->logger->expects($this->once())->method('warning');

		$this->assertSame([], $this->subject->fetch(['11111111-1111-1111-1111-111111111111']));
	}

	public function testPartialResponseOnlyExposesPresentRooms(): void {
		// Daemon knows about one of the two requested UUIDs.
		$body = json_encode([
			'rooms' => [
				'11111111-1111-1111-1111-111111111111' => [
					'connectedCount' => 0,
					'clients' => [],
					'playerState' => 'paused',
					'videoPos' => 0.0,
					'lastActivityMs' => null,
				],
			],
		]);
		$this->stubResponse(status: 200, body: $body);

		$result = $this->subject->fetch([
			'11111111-1111-1111-1111-111111111111',
			'22222222-2222-2222-2222-222222222222',
		]);
		$this->assertArrayHasKey('11111111-1111-1111-1111-111111111111', $result);
		$this->assertArrayNotHasKey('22222222-2222-2222-2222-222222222222', $result);
	}

	public function testSendsHmacHeaderToDaemon(): void {
		$capturedOptions = null;
		$this->httpClient->expects($this->once())
			->method('get')
			->willReturnCallback(function (string $url, array $options) use (&$capturedOptions) {
				$capturedOptions = $options;
				$resp = $this->createMock(IResponse::class);
				$resp->method('getStatusCode')->willReturn(200);
				$resp->method('getBody')->willReturn('{"rooms":{}}');
				return $resp;
			});

		$this->subject->fetch(['11111111-1111-1111-1111-111111111111']);

		$this->assertNotNull($capturedOptions);
		$this->assertArrayHasKey('headers', $capturedOptions);
		$this->assertArrayHasKey('X-PBSync-Admin', $capturedOptions['headers']);
		$this->assertMatchesRegularExpression(
			'/^t=\d+,sig=[0-9a-f]{64}$/',
			$capturedOptions['headers']['X-PBSync-Admin'],
		);
	}

	private function stubResponse(int $status, string $body): void {
		$response = $this->createMock(IResponse::class);
		$response->method('getStatusCode')->willReturn($status);
		$response->method('getBody')->willReturn($body);
		$this->httpClient->method('get')->willReturn($response);
	}
}
