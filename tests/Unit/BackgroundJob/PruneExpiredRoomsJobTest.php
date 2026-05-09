<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\BackgroundJob;

use OCA\PlaybackSync\BackgroundJob\PruneExpiredRoomsJob;
use OCA\PlaybackSync\Db\RoomMapper;
use OCP\AppFramework\Utility\ITimeFactory;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

class PruneExpiredRoomsJobTest extends TestCase {

	private const FIXED_TIME_S = 1_700_000_000;
	private const FIXED_TIME_MS = 1_700_000_000_000;

	private ITimeFactory&MockObject $timeFactory;
	private RoomMapper&MockObject $mapper;
	private PruneExpiredRoomsJob $job;

	protected function setUp(): void {
		parent::setUp();
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->timeFactory->method('getTime')->willReturn(self::FIXED_TIME_S);
		$this->mapper = $this->createMock(RoomMapper::class);
		$this->job = new PruneExpiredRoomsJob($this->timeFactory, $this->mapper);
	}

	/**
	 * `run` calls the mapper's bulk-delete with the *current* time converted
	 * to milliseconds. The mapper deletes every row whose `expires_at` is
	 * less than or equal to that value.
	 */
	public function testRunCallsDeleteExpiredWithCurrentMillis(): void {
		$this->mapper->expects($this->once())
			->method('deleteExpired')
			->with(self::FIXED_TIME_MS)
			->willReturn(3);

		$this->invokeRun();
	}

	/**
	 * The job is idempotent: running it when nothing is expired (mapper
	 * returns 0) is a no-op that completes without errors. This is the
	 * typical case in production once the rooms table is small.
	 */
	public function testRunIsNoOpWhenNothingExpired(): void {
		$this->mapper->expects($this->once())
			->method('deleteExpired')
			->willReturn(0);

		$this->invokeRun();
		$this->addToAssertionCount(1);
	}

	/**
	 * Invoke the protected `run` method via reflection. Doing it this way
	 * keeps the production class clean — no test-only public accessor — and
	 * still exercises the exact code path that the cron worker hits.
	 */
	private function invokeRun(): void {
		$method = new ReflectionMethod($this->job, 'run');
		$method->invoke($this->job, null);
	}
}
