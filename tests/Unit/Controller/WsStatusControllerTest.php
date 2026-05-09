<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Controller;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Controller\WsStatusController;
use OCP\IAppConfig;
use OCP\IRequest;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class WsStatusControllerTest extends TestCase {

	private IRequest&MockObject $request;
	private IAppConfig&MockObject $appConfig;
	private WsStatusController $controller;

	protected function setUp(): void {
		parent::setUp();
		$this->request = $this->createMock(IRequest::class);
		$this->appConfig = $this->createMock(IAppConfig::class);
		$this->controller = new WsStatusController(Application::APP_ID, $this->request, $this->appConfig);
	}

	public function testReturnsAvailableTrueWhenInstalledAndConfigured(): void {
		$this->appConfig->method('getValueString')
			->with(Application::APP_ID, 'ws_host', '')
			->willReturn('127.0.0.1');
		$this->appConfig->method('getValueInt')
			->with(Application::APP_ID, 'ws_port', 0)
			->willReturn(8765);

		$response = $this->controller->index();
		$this->assertSame(['available' => true], $response->getData());
	}

	public function testReturnsAvailableFalseWhenHostIsEmpty(): void {
		$this->appConfig->method('getValueString')->willReturn('');
		$this->appConfig->method('getValueInt')->willReturn(8765);

		$response = $this->controller->index();
		$this->assertSame(['available' => false], $response->getData());
	}

	public function testReturnsAvailableFalseWhenPortIsZero(): void {
		$this->appConfig->method('getValueString')->willReturn('127.0.0.1');
		$this->appConfig->method('getValueInt')->willReturn(0);

		$response = $this->controller->index();
		$this->assertSame(['available' => false], $response->getData());
	}

	public function testReturnsAvailableFalseWhenPortIsNegative(): void {
		$this->appConfig->method('getValueString')->willReturn('127.0.0.1');
		$this->appConfig->method('getValueInt')->willReturn(-1);

		$response = $this->controller->index();
		$this->assertSame(['available' => false], $response->getData());
	}
}
