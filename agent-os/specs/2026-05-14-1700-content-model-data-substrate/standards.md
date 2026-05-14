# Standards for Content Model Data Substrate

The following standards apply to this work.

---

## backend/php-conventions

Source: [agent-os/standards/backend/php-conventions.md](../../standards/backend/php-conventions.md)

# PHP Backend Conventions

All PHP files start with:
```php
<?php
declare(strict_types=1);
```

## Application bootstrap

- `Application` extends `App` and implements `IBootstrap`
- Always define `APP_ID` as a constant — use it everywhere the app slug is needed
- Register services/listeners in `register()`, perform boot logic in `boot()`

## Namespaces and imports

- Only import from `OCP\` — never `OC\` (internal, unstable Nextcloud API)
- App namespace: `OCA\PlaybackSync\`

## Controllers

- Annotate actions with `@NoAdminRequired` and `@NoCSRFRequired` where appropriate (PHPDoc block above the method)
- Use `Util::addScript('playbacksync', 'playbacksync-main')` to enqueue the compiled frontend bundle
- Return `TemplateResponse` for page routes

---

## Project-level conventions (from `CLAUDE.md`)

These are additional rules pulled from [CLAUDE.md](../../../CLAUDE.md) that apply to PHP work in this app:

- **No author/license/SPDX headers.** No `@author`, `@copyright`, `SPDX-FileCopyrightText`, or `SPDX-License-Identifier` in any file.
- **No docblock boilerplate**, but real PHPDoc with meaningful `@param` / `@return` descriptions is welcome. Functional `@method` hints on `Entity` subclasses are required, not boilerplate.
- **Comments explain the *why*, not the *what*.** Code style: comments only when a constraint, invariant, or surprise warrants them.
