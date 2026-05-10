<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Controller\WsStatusController;
use OCA\PlaybackSync\Service\HealthClient;
use OCP\IAppConfig;
use OCP\IRequest;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class WsStatusControllerTest extends TestCase {

	private IRequest&MockObject $request;
	private IAppConfig&MockObject $appConfig;
	private HealthClient&MockObject $healthClient;
	private WsStatusController $controller;

	protected function setUp(): void {
		parent::setUp();
		$this->request = $this->createMock(IRequest::class);
		$this->appConfig = $this->createMock(IAppConfig::class);
		$this->healthClient = $this->createMock(HealthClient::class);
		$this->controller = new WsStatusController(
			Application::APP_ID,
			$this->request,
			$this->appConfig,
			$this->healthClient,
		);
	}

	public function testReturnsAvailableTrueWhenInstalledConfiguredAndDaemonHealthy(): void {
		$this->stubInstalled();
		$this->healthClient->method('fetch')->willReturn([
			'reachable' => true,
			'latency_ms' => 3,
			'body' => ['status' => 'ok'],
		]);

		$response = $this->controller->index();
		$this->assertSame(['available' => true, 'reason' => null], $response->getData());
	}

	public function testReturnsNotInstalledWhenHostIsEmpty(): void {
		$this->appConfig->method('getValueString')->willReturn('');
		$this->appConfig->method('getValueInt')->willReturn(8765);
		$this->healthClient->expects($this->never())->method('fetch');

		$response = $this->controller->index();
		$this->assertSame(
			['available' => false, 'reason' => WsStatusController::REASON_NOT_INSTALLED],
			$response->getData(),
		);
	}

	public function testReturnsNotInstalledWhenPortIsZero(): void {
		$this->appConfig->method('getValueString')->willReturn('127.0.0.1');
		$this->appConfig->method('getValueInt')->willReturn(0);
		$this->healthClient->expects($this->never())->method('fetch');

		$response = $this->controller->index();
		$this->assertSame(
			['available' => false, 'reason' => WsStatusController::REASON_NOT_INSTALLED],
			$response->getData(),
		);
	}

	public function testReturnsNotInstalledWhenPortIsNegative(): void {
		$this->appConfig->method('getValueString')->willReturn('127.0.0.1');
		$this->appConfig->method('getValueInt')->willReturn(-1);
		$this->healthClient->expects($this->never())->method('fetch');

		$response = $this->controller->index();
		$this->assertSame(
			['available' => false, 'reason' => WsStatusController::REASON_NOT_INSTALLED],
			$response->getData(),
		);
	}

	public function testReturnsNotRunningWhenDaemonUnreachable(): void {
		$this->stubInstalled();
		$this->healthClient->method('fetch')->willReturn([
			'reachable' => false,
			'error' => 'request_failed',
		]);

		$response = $this->controller->index();
		$this->assertSame(
			['available' => false, 'reason' => WsStatusController::REASON_NOT_RUNNING],
			$response->getData(),
		);
	}

	public function testReturnsNotRunningWhenDaemonReachableButReportsDegraded(): void {
		$this->stubInstalled();
		$this->healthClient->method('fetch')->willReturn([
			'reachable' => true,
			'latency_ms' => 5,
			'body' => ['status' => 'degraded'],
		]);

		$response = $this->controller->index();
		$this->assertSame(
			['available' => false, 'reason' => WsStatusController::REASON_NOT_RUNNING],
			$response->getData(),
		);
	}

	public function testReturnsNotRunningWhenDaemonReachableButBodyMissesStatusField(): void {
		// Daemon answered with an unexpected payload — don't trust it as healthy.
		$this->stubInstalled();
		$this->healthClient->method('fetch')->willReturn([
			'reachable' => true,
			'latency_ms' => 5,
			'body' => ['some_other_field' => 'value'],
		]);

		$response = $this->controller->index();
		$this->assertSame(
			['available' => false, 'reason' => WsStatusController::REASON_NOT_RUNNING],
			$response->getData(),
		);
	}

	private function stubInstalled(): void {
		$this->appConfig->method('getValueString')
			->with(Application::APP_ID, 'ws_host', '')
			->willReturn('127.0.0.1');
		$this->appConfig->method('getValueInt')
			->with(Application::APP_ID, 'ws_port', 0)
			->willReturn(8765);
	}
}
