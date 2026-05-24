<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Migration;

use OCA\PlaybackSync\AppInfo\Application;
use OCA\PlaybackSync\Migration\EnsureDefaultSettings;
use OCA\PlaybackSync\Settings\SettingsDefaults;
use OCP\IAppConfig;
use OCP\Migration\IOutput;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class EnsureDefaultSettingsTest extends TestCase {

	private IAppConfig&MockObject $appConfig;
	private IOutput&MockObject $output;
	private EnsureDefaultSettings $subject;

	protected function setUp(): void {
		parent::setUp();
		$this->appConfig = $this->createMock(IAppConfig::class);
		$this->output = $this->createMock(IOutput::class);
		$this->subject = new EnsureDefaultSettings($this->appConfig);
	}

	public function testSeedsEveryDefaultWhenNoKeysArePresent(): void {
		$this->appConfig->method('hasKey')->willReturn(false);

		$writtenInts = [];
		$writtenStrings = [];
		$writtenBools = [];

		$this->appConfig->expects($this->exactly(count(SettingsDefaults::INT_DEFAULTS)))
			->method('setValueInt')
			->willReturnCallback(function (string $app, string $key, int $value) use (&$writtenInts): bool {
				$this->assertSame(Application::APP_ID, $app);
				$writtenInts[$key] = $value;
				return true;
			});

		$this->appConfig->expects($this->exactly(count(SettingsDefaults::STRING_DEFAULTS)))
			->method('setValueString')
			->willReturnCallback(function (string $app, string $key, string $value) use (&$writtenStrings): bool {
				$this->assertSame(Application::APP_ID, $app);
				$writtenStrings[$key] = $value;
				return true;
			});

		$this->appConfig->expects($this->exactly(count(SettingsDefaults::BOOL_DEFAULTS)))
			->method('setValueBool')
			->willReturnCallback(function (string $app, string $key, bool $value) use (&$writtenBools): bool {
				$this->assertSame(Application::APP_ID, $app);
				$writtenBools[$key] = $value;
				return true;
			});

		$this->output->expects($this->once())
			->method('info')
			->with($this->stringContains('seeded'));

		$this->subject->run($this->output);

		$this->assertSame(SettingsDefaults::INT_DEFAULTS, $writtenInts);
		$this->assertSame(SettingsDefaults::STRING_DEFAULTS, $writtenStrings);
		$this->assertSame(SettingsDefaults::BOOL_DEFAULTS, $writtenBools);
	}

	public function testIsNoOpWhenEveryKeyIsAlreadyPresent(): void {
		$this->appConfig->method('hasKey')->willReturn(true);

		$this->appConfig->expects($this->never())->method('setValueInt');
		$this->appConfig->expects($this->never())->method('setValueString');
		$this->appConfig->expects($this->never())->method('setValueBool');

		$this->output->expects($this->once())
			->method('info')
			->with($this->stringContains('already present'));

		$this->subject->run($this->output);
	}

	public function testSeedsOnlyTheKeysThatAreMissing(): void {
		// Pretend the admin has already saved `ws_port` and `ws_host`, but every
		// other key is fresh. Only the missing keys should be written.
		$preset = ['ws_port' => true, 'ws_host' => true];

		$this->appConfig->method('hasKey')
			->willReturnCallback(static fn (string $app, string $key): bool => isset($preset[$key]));

		$writtenIntKeys = [];
		$writtenStringKeys = [];
		$writtenBoolKeys = [];

		$this->appConfig->method('setValueInt')
			->willReturnCallback(function (string $app, string $key, int $value) use (&$writtenIntKeys): bool {
				$writtenIntKeys[] = $key;
				return true;
			});
		$this->appConfig->method('setValueString')
			->willReturnCallback(function (string $app, string $key, string $value) use (&$writtenStringKeys): bool {
				$writtenStringKeys[] = $key;
				return true;
			});
		$this->appConfig->method('setValueBool')
			->willReturnCallback(function (string $app, string $key, bool $value) use (&$writtenBoolKeys): bool {
				$writtenBoolKeys[] = $key;
				return true;
			});

		$this->subject->run($this->output);

		$this->assertNotContains('ws_port', $writtenIntKeys, 'pre-existing int key must not be re-written');
		$this->assertNotContains('ws_host', $writtenStringKeys, 'pre-existing string key must not be re-written');

		// Spot-check one untouched int key is seeded so we know the loop did run.
		$this->assertContains('ws_admin_port', $writtenIntKeys);
		$this->assertContains('ws_admin_host', $writtenStringKeys);
		$this->assertContains('restrict_to_admins', $writtenBoolKeys);
	}
}
