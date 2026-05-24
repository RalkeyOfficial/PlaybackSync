<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Controller\WsStatusController;
use OCA\PlaybackSync\Service\HealthClient;
use OCP\IRequest;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class WsStatusControllerTest extends TestCase {

	private IRequest&MockObject $request;
	private HealthClient&MockObject $healthClient;
	private WsStatusController $controller;

	protected function setUp(): void {
		parent::setUp();
		$this->request = $this->createMock(IRequest::class);
		$this->healthClient = $this->createMock(HealthClient::class);
		$this->controller = new WsStatusController(
			Application::APP_ID,
			$this->request,
			$this->healthClient,
		);
	}

	public function testReturnsAvailableTrueWhenDaemonHealthy(): void {
		$this->healthClient->method('fetch')->willReturn([
			'reachable' => true,
			'latency_ms' => 3,
			'body' => ['status' => 'ok'],
		]);

		$response = $this->controller->index();
		$this->assertSame(['available' => true, 'reason' => null], $response->getData());
	}

	public function testReturnsNotRunningWhenDaemonUnreachable(): void {
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
}
