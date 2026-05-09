<?php

declare(strict_types=1);

/*
 * Tests run inside the Nextcloud Docker container so the full Nextcloud
 * environment (autoloader, OCP interfaces, \OC::$server) is available to
 * any test that needs it. Pure unit tests don't actually exercise any of
 * that — they mock the OCP interfaces — but loading base.php is what makes
 * `OCP\Foo\Bar` typehints resolve at all.
 */

define('PHPUNIT_RUN', 1);

require_once __DIR__ . '/../../../lib/base.php';

// Autoload our own test classes by mirroring the OCA\PlaybackSync\Tests namespace
// to the tests/ directory. We don't ship a composer.json, so this little PSR-4
// shim is enough.
spl_autoload_register(static function (string $class): void {
	$prefix = 'OCA\\PlaybackSync\\Tests\\';
	if (!str_starts_with($class, $prefix)) {
		return;
	}
	$relative = substr($class, strlen($prefix));
	$path = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';
	if (file_exists($path)) {
		require_once $path;
	}
});
