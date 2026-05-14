<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Db;

use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * @template-extends QBMapper<Room>
 */
class RoomMapper extends QBMapper {

	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'playbacksync_rooms', Room::class);
	}

	/**
	 * @throws DoesNotExistException
	 */
	public function findByUuid(string $uuid): Room {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->tableName)
			->where($qb->expr()->eq('uuid', $qb->createNamedParameter($uuid)));

		return $this->findEntity($qb);
	}

	/**
	 * Fetch a room row with a pessimistic row lock so the caller can
	 * read-modify-write the JSON `playlist` blob without racing another
	 * writer. Must be invoked inside an open transaction — the lock is
	 * released on commit/rollback.
	 *
	 * @throws DoesNotExistException
	 */
	public function lockRoomForUpdate(string $uuid): Room {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->tableName)
			->where($qb->expr()->eq('uuid', $qb->createNamedParameter($uuid)));

		// `FOR UPDATE` is supported by every database backend the QBMapper
		// stack runs on (MySQL/MariaDB/PostgreSQL); SQLite is single-writer
		// already so the statement is harmless there.
		$sql = $qb->getSQL() . ' FOR UPDATE';
		$stmt = $this->db->executeQuery($sql, $qb->getParameters(), $qb->getParameterTypes());
		$row = $stmt->fetchAssociative();
		$stmt->closeCursor();

		if ($row === false) {
			throw new DoesNotExistException('Room not found: ' . $uuid);
		}

		return Room::fromRow($row);
	}

	/**
	 * Active (non-expired) rooms owned by a user, newest first.
	 *
	 * @return Room[]
	 */
	public function findActiveByOwner(string $userId, int $now): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->tableName)
			->where($qb->expr()->eq('owner_user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->gt('expires_at', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT)))
			->orderBy('created_at', 'DESC');

		return $this->findEntities($qb);
	}

	public function deleteExpired(int $now): int {
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->tableName)
			->where($qb->expr()->lte('expires_at', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT)));

		return $qb->executeStatement();
	}
}
