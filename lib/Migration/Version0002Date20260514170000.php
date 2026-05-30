<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Drops `playbacksync_rooms` and recreates it with the playlist + cursor +
 * toggles substrate.
 *
 * Pre-launch project: no real users, no data to preserve. Rather than
 * layering ALTER TABLE on top of Version0001, we drop the table and
 * rebuild from scratch with the new shape — the rename of `target_url`
 * to `bootstrap_url`, the toggle columns, the JSON-serialized playlist,
 * and the `cursor_entry_id` reference.
 *
 * The new shape is the data substrate defined in CONTENT_MODEL_DATA.md.
 * Referential integrity between `cursor_entry_id` and an entry in the
 * `playlist` JSON is enforced at the service layer (see PlaylistService),
 * not in the schema — JSON-aware CHECK constraints aren't portable across
 * supported databases.
 */
class Version0002Date20260514170000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if ($schema->hasTable('playbacksync_rooms')) {
			$schema->dropTable('playbacksync_rooms');
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
		$table->addColumn('bootstrap_url', Types::TEXT, [
			'notnull' => true,
		]);
		$table->addColumn('password_hash', Types::STRING, [
			'notnull' => true,
			'length' => 255,
		]);
		// Nextcloud's schema check rejects NOT NULL boolean columns (a DBAL
		// portability guard), so these are nullable; the service layer always
		// writes an explicit true/false, and the default covers omitted inserts.
		$table->addColumn('single_mode', Types::BOOLEAN, [
			'notnull' => false,
			'default' => false,
		]);
		$table->addColumn('freeform_mode', Types::BOOLEAN, [
			'notnull' => false,
			'default' => false,
		]);
		$table->addColumn('playlist', Types::TEXT, [
			'notnull' => true,
			'default' => '[]',
		]);
		$table->addColumn('cursor_entry_id', Types::STRING, [
			'notnull' => false,
			'length' => 64,
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
