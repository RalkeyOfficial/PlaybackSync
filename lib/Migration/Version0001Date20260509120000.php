<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version0001Date20260509120000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('playbacksync_rooms')) {
			return null;
		}

		$table = $schema->createTable('playbacksync_rooms');

		$table->addColumn('id', Types::BIGINT, [
			'autoincrement' => true,
			'notnull' => true,
			'length' => 20,
			'unsigned' => true,
		]);
		$table->addColumn('uuid', Types::STRING, [
			'notnull' => true,
			'length' => 36,
		]);
		$table->addColumn('owner_user_id', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('name', Types::STRING, [
			'notnull' => false,
			'length' => 100,
		]);
		$table->addColumn('target_url', Types::TEXT, [
			'notnull' => true,
		]);
		$table->addColumn('password_hash', Types::STRING, [
			'notnull' => true,
			'length' => 255,
		]);
		$table->addColumn('created_at', Types::BIGINT, [
			'notnull' => true,
			'length' => 20,
			'unsigned' => true,
		]);
		$table->addColumn('expires_at', Types::BIGINT, [
			'notnull' => true,
			'length' => 20,
			'unsigned' => true,
		]);

		$table->setPrimaryKey(['id']);
		$table->addUniqueIndex(['uuid'], 'playbacksync_rooms_uuid_ix');
		$table->addIndex(['owner_user_id'], 'playbacksync_rooms_owner_ix');
		$table->addIndex(['expires_at'], 'playbacksync_rooms_exp_ix');

		return $schema;
	}
}
