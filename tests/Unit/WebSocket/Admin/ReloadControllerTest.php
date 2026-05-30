<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\WebSocket\Admin;

use OCA\PlaybackSync\WebSocket\Admin\ReloadController;
use OCA\PlaybackSync\WebSocket\WsConfig;
use OCP\IAppConfig;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;

class ReloadControllerTest extends TestCase {

	public function testReloadDelegatesToWsConfigAndReturnsChanged(): void {
		$changed = ['driftNudgeThresholdMs' => ['from' => 200, 'to' => 400]];

		$appConfig = $this->createMock(IAppConfig::class);
		$config = $this->createMock(WsConfig::class);
		$config->expects($this->once())->method('reloadFrom')->with($appConfig)->willReturn($changed);

		$logger = $this->createMock(LoggerInterface::class);
		$logger->expects($this->once())->method('info');

		$controller = new ReloadController($config, $appConfig, $logger);

		$this->assertSame($changed, $controller->reload());
	}

	public function testReloadWithNoChangesStillReturnsEmptyArray(): void {
		$appConfig = $this->createMock(IAppConfig::class);
		$config = $this->createMock(WsConfig::class);
		$config->method('reloadFrom')->willReturn([]);

		$controller = new ReloadController($config, $appConfig, $this->createMock(LoggerInterface::class));

		$this->assertSame([], $controller->reload());
	}
}
