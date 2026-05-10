# Standards for Public Share Endpoint

The following standards apply to this work.

---

## backend/php-conventions

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

## Application to this work

- The new `ShareController` lives under `OCA\PlaybackSync\Controller\` and only imports from `OCP\`.
- All annotations use PHP 8 attribute syntax (matching every other controller in this codebase, despite the standard's example phrasing — see `HealthController`, `RoomController`, etc.). The standard's "PHPDoc block" wording is from a pre-attribute era; the in-repo precedent is unambiguous.
- This route does **not** render a page, so `Util::addScript` and `TemplateResponse` do not apply. The success path returns a `RedirectResponse`; failure paths return `DataResponse` (JSON).
- No author / copyright / SPDX headers on any new file.
