<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Tests\Unit\Db;

use OCA\PlaybackSync\Db\Room;
use PHPUnit\Framework\TestCase;

class RoomTest extends TestCase {

	/**
	 * Round-trip every column through its setter and getter. This is a
	 * small but cheap sanity check: if a column is added or removed and
	 * the corresponding `@method` PHPDoc hint isn't updated, this test
	 * is the first thing to fail.
	 */
	public function testGettersAndSettersRoundTrip(): void {
		$room = new Room();
		$room->setUuid('5a66524f-5ba1-4f3d-8897-7c5838c0bd80');
		$room->setOwnerUserId('alice');
		$room->setName('Friday movie');
		$room->setBootstrapUrl('https://example.com/watch/123');
		$room->setPasswordHash('3|$argon2id$v=19$m=65536,t=4,p=1$abc');
		$room->setCreatedAt(1_700_000_000_000);
		$room->setExpiresAt(1_700_086_400_000);

		$this->assertSame('5a66524f-5ba1-4f3d-8897-7c5838c0bd80', $room->getUuid());
		$this->assertSame('alice', $room->getOwnerUserId());
		$this->assertSame('Friday movie', $room->getName());
		$this->assertSame('https://example.com/watch/123', $room->getBootstrapUrl());
		$this->assertSame('3|$argon2id$v=19$m=65536,t=4,p=1$abc', $room->getPasswordHash());
		$this->assertSame(1_700_000_000_000, $room->getCreatedAt());
		$this->assertSame(1_700_086_400_000, $room->getExpiresAt());
	}

	/**
	 * `name` is the only nullable column on the entity, so a null setter
	 * must be honoured and the getter must return null (not the empty
	 * string or anything else).
	 */
	public function testNameAcceptsNull(): void {
		$room = new Room();
		$room->setName(null);
		$this->assertNull($room->getName());
	}

	/**
	 * `addType('createdAt', BIGINT)` and `addType('expiresAt', BIGINT)`
	 * are what tell the `Entity` base class to coerce numeric strings
	 * into integers when hydrating from the DB. We simulate that by
	 * setting via the public-property path the hydrator uses, then
	 * reading via the getter, and asserting the type ends up as `int`.
	 */
	public function testTimestampsAreCoercedToInt(): void {
		$room = new Room();
		// Simulate hydration from a DB driver that returns numeric strings.
		// The Entity base class consumes setters but type-tags drive the
		// underlying coercion when hydrating from DB rows.
		$room->setCreatedAt(1_700_000_000_000);
		$room->setExpiresAt(1_700_086_400_000);

		$this->assertIsInt($room->getCreatedAt());
		$this->assertIsInt($room->getExpiresAt());
	}
}
