<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Db;

use OCP\AppFramework\Db\Entity;
use OCP\DB\Types;

/**
 * @method int getId()
 * @method void setId(int $id)
 * @method string getUuid()
 * @method void setUuid(string $uuid)
 * @method string getOwnerUserId()
 * @method void setOwnerUserId(string $ownerUserId)
 * @method string|null getName()
 * @method void setName(?string $name)
 * @method string getTargetUrl()
 * @method void setTargetUrl(string $targetUrl)
 * @method string getPasswordHash()
 * @method void setPasswordHash(string $passwordHash)
 * @method int getCreatedAt()
 * @method void setCreatedAt(int $createdAt)
 * @method int getExpiresAt()
 * @method void setExpiresAt(int $expiresAt)
 */
class Room extends Entity {

	/** @var string */
	public $uuid;

	/** @var string */
	public $ownerUserId;

	/** @var string|null */
	public $name;

	/** @var string */
	public $targetUrl;

	/** @var string */
	public $passwordHash;

	/** @var int */
	public $createdAt;

	/** @var int */
	public $expiresAt;

	public function __construct() {
		$this->addType('uuid', 'string');
		$this->addType('ownerUserId', 'string');
		$this->addType('name', 'string');
		$this->addType('targetUrl', 'string');
		$this->addType('passwordHash', 'string');
		$this->addType('createdAt', Types::BIGINT);
		$this->addType('expiresAt', Types::BIGINT);
	}
}
