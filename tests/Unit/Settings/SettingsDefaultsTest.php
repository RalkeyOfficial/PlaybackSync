<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Settings;

use OCA\PlaybackSync\Settings\SettingsDefaults;
use PHPUnit\Framework\TestCase;

/**
 * Guard-rails around the central defaults registry. These tests aren't
 * exercising behaviour so much as catching accidents:
 *   - a key drifting between the three typed maps,
 *   - the daemon binding losing its install-time values,
 *   - a future contributor swapping a typed value for the wrong PHP type.
 *
 * They are cheap and they fail loudly the moment someone breaks the contract
 * that the install migration and the readers across the codebase depend on.
 */
class SettingsDefaultsTest extends TestCase {

	public function testDaemonBindingKeysCarryTheirHistoricalDefaults(): void {
		// The whole bug that motivated this seed step was the daemon running
		// on these hardcoded values while IAppConfig was empty. The install
		// step has to persist *these specific numbers* or the daemon's
		// observable behaviour will change for fresh installs.
		$this->assertSame('127.0.0.1', SettingsDefaults::STRING_DEFAULTS['ws_host']);
		$this->assertSame('127.0.0.1', SettingsDefaults::STRING_DEFAULTS['ws_admin_host']);
		$this->assertSame(8765, SettingsDefaults::INT_DEFAULTS['ws_port']);
		$this->assertSame(8766, SettingsDefaults::INT_DEFAULTS['ws_admin_port']);
	}

	public function testEveryDefaultMapHoldsTheCorrectPhpType(): void {
		foreach (SettingsDefaults::INT_DEFAULTS as $key => $value) {
			$this->assertIsInt($value, "INT_DEFAULTS[$key] must be an int");
		}
		foreach (SettingsDefaults::STRING_DEFAULTS as $key => $value) {
			$this->assertIsString($value, "STRING_DEFAULTS[$key] must be a string");
		}
		foreach (SettingsDefaults::BOOL_DEFAULTS as $key => $value) {
			$this->assertIsBool($value, "BOOL_DEFAULTS[$key] must be a bool");
		}
	}

	public function testNoKeyAppearsInMoreThanOneTypeMap(): void {
		$intKeys = array_keys(SettingsDefaults::INT_DEFAULTS);
		$stringKeys = array_keys(SettingsDefaults::STRING_DEFAULTS);
		$boolKeys = array_keys(SettingsDefaults::BOOL_DEFAULTS);

		$this->assertSame([], array_intersect($intKeys, $stringKeys));
		$this->assertSame([], array_intersect($intKeys, $boolKeys));
		$this->assertSame([], array_intersect($stringKeys, $boolKeys));
	}
}
