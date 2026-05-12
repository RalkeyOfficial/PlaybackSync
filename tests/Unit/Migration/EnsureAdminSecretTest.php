<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Migration;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Migration\EnsureAdminSecret;
use OCA\PlaybackSync\Service\AdminSecretService;
use OCP\IAppConfig;
use OCP\Migration\IOutput;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class EnsureAdminSecretTest extends TestCase {

	private IAppConfig&MockObject $appConfig;
	private IOutput&MockObject $output;
	private EnsureAdminSecret $subject;

	protected function setUp(): void {
		parent::setUp();
		$this->appConfig = $this->createMock(IAppConfig::class);
		$this->output = $this->createMock(IOutput::class);
		// Wrap the IAppConfig mock in a real AdminSecretService so the
		// IAppConfig-level assertions below (length, hex shape, sensitive flag)
		// keep exercising the same observable contract they did before the
		// secret-handling was extracted out of the repair step itself.
		$this->subject = new EnsureAdminSecret(new AdminSecretService($this->appConfig));
	}

	public function testGeneratesSecretWhenMissing(): void {
		$this->appConfig->method('getValueString')
			->with(Application::APP_ID, 'ws_admin_secret', '')
			->willReturn('');

		$captured = null;
		$this->appConfig->expects($this->once())
			->method('setValueString')
			->willReturnCallback(function (string $app, string $key, string $value, bool $lazy = false, bool $sensitive = false) use (&$captured): bool {
				$this->assertSame(Application::APP_ID, $app);
				$this->assertSame('ws_admin_secret', $key);
				$this->assertTrue($sensitive, 'secret must be flagged sensitive in IAppConfig');
				$captured = $value;
				return true;
			});

		$this->subject->run($this->output);

		$this->assertNotNull($captured);
		$this->assertSame(64, strlen($captured), 'secret is 32 bytes hex-encoded → 64 chars');
		$this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $captured);
	}

	public function testIsNoOpWhenSecretAlreadySet(): void {
		$this->appConfig->method('getValueString')
			->willReturn('existing-non-empty-secret');

		$this->appConfig->expects($this->never())->method('setValueString');

		$this->subject->run($this->output);
	}
}
