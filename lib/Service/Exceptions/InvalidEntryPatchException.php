<?php

declare(strict_types=1);

namespace OCA\PlaybackSync\Service\Exceptions;

/**
 * Raised when `PATCH /playlist/entries/{id}` carries a field value that
 * violates the per-field invariants — for example, a `source` transition
 * other than `scraped`/`auto_appended` → `curated`. Wire-protocol mapping:
 * `invalid_entry_patch`.
 */
class InvalidEntryPatchException extends \RuntimeException {
}
