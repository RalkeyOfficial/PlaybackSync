<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\BackgroundJob;

use OCA\PlaybackSync\Db\RoomMapper;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;

class PruneExpiredRoomsJob extends TimedJob {

	private const INTERVAL_SECONDS = 3600;

	public function __construct(
		ITimeFactory $time,
		private RoomMapper $mapper,
	) {
		parent::__construct($time);
		$this->setInterval(self::INTERVAL_SECONDS);
	}

	protected function run($argument): void {
		$now = $this->time->getTime() * 1000;
		$this->mapper->deleteExpired($now);
	}
}
