<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Controller\HealthController;
use OCA\PlaybackSync\Service\HealthClient;
use OCP\IRequest;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class HealthControllerTest extends TestCase {

	private IRequest&MockObject $request;
	private HealthClient&MockObject $client;
	private HealthController $controller;

	protected function setUp(): void {
		parent::setUp();
		$this->request = $this->createMock(IRequest::class);
		$this->client = $this->createMock(HealthClient::class);
		$this->controller = new HealthController(Application::APP_ID, $this->request, $this->client);
	}

	public function testReturnsOkWhenDaemonReachableAndHealthy(): void {
		$daemonBody = [
			'status' => 'ok',
			'daemon_version' => '0.3.0',
			'uptime_seconds' => 42,
			'rooms' => ['active' => 1],
			'clients' => ['connected' => 2],
		];
		$this->client->method('fetch')->willReturn([
			'reachable' => true,
			'latency_ms' => 7,
			'body' => $daemonBody,
		]);

		$response = $this->controller->index();
		$data = $response->getData();

		$this->assertSame('ok', $data['status']);
		$this->assertTrue($data['daemon']['reachable']);
		$this->assertSame(7, $data['daemon']['latency_ms']);
		$this->assertSame($daemonBody, $data['daemon']['body']);
	}

	public function testReturnsDegradedWhenDaemonUnreachable(): void {
		$this->client->method('fetch')->willReturn([
			'reachable' => false,
			'error' => 'request_failed',
		]);

		$response = $this->controller->index();
		$data = $response->getData();

		$this->assertSame('degraded', $data['status']);
		$this->assertFalse($data['daemon']['reachable']);
		$this->assertSame('request_failed', $data['daemon']['error']);
		// HTTP status is always 200 — load balancers misread 5xx from a healthcheck.
		$this->assertSame(200, $response->getStatus());
	}

	public function testReturnsDegradedWhenDaemonReachableButReportsNonOk(): void {
		$this->client->method('fetch')->willReturn([
			'reachable' => true,
			'latency_ms' => 3,
			'body' => ['status' => 'degraded', 'reason' => 'tick stalled'],
		]);

		$response = $this->controller->index();
		$data = $response->getData();

		$this->assertSame('degraded', $data['status']);
		$this->assertTrue($data['daemon']['reachable']);
		$this->assertSame(200, $response->getStatus());
	}

	public function testReturnsDegradedWhenDaemonBodyMissingStatusField(): void {
		// Daemon answered but with an unexpected payload. Don't trust it as "ok".
		$this->client->method('fetch')->willReturn([
			'reachable' => true,
			'latency_ms' => 3,
			'body' => ['some_other_field' => 'value'],
		]);

		$response = $this->controller->index();
		$this->assertSame('degraded', $response->getData()['status']);
	}

	public function testHttpStatusIsAlways200(): void {
		// Sanity: every variant returns 200 — never let a 5xx leak from a healthcheck.
		foreach ([
			['reachable' => false, 'error' => 'request_failed'],
			['reachable' => false, 'error' => 'http_500'],
			['reachable' => true, 'latency_ms' => 1, 'body' => ['status' => 'ok']],
			['reachable' => true, 'latency_ms' => 1, 'body' => ['status' => 'degraded']],
		] as $probe) {
			$client = $this->createMock(HealthClient::class);
			$client->method('fetch')->willReturn($probe);
			$controller = new HealthController(Application::APP_ID, $this->request, $client);
			$this->assertSame(200, $controller->index()->getStatus());
		}
	}
}
