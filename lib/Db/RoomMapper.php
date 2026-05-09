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
