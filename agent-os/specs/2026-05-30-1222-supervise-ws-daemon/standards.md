# Standards for Supervise the WS daemon

The following standard applies to this work.

---

## backend/php-conventions

> Applies to the only PHP change in this spec: the SIGTERM/SIGINT handler added to
> `lib/Command/WsServe.php`.

All PHP files start with:
```php
<?php
declare(strict_types=1);
```

### Application bootstrap

- `Application` extends `App` and implements `IBootstrap`
- Always define `APP_ID` as a constant — use it everywhere the app slug is needed
- Register services/listeners in `register()`, perform boot logic in `boot()`

### Namespaces and imports

- Only import from `OCP\` — never `OC\` (internal, unstable Nextcloud API)
- App namespace: `OCA\PlaybackSync\`

### Controllers

- Annotate actions with `@NoAdminRequired` and `@NoCSRFRequired` where appropriate (PHPDoc block above the method)
- Use `Util::addScript('playbacksync', 'playbacksync-main')` to enqueue the compiled frontend bundle
- Return `TemplateResponse` for page routes

---

### How it applies here

`WsServe.php` already declares strict types and imports only from `OCP\` /
`React\` / `Ratchet\`. The signal handler is a closure inside `execute()` — no new
imports needed (`SIGTERM`/`SIGINT` are global constants). Project rule (CLAUDE.md): no
SPDX/author/license headers; comments explain the *why* (why `$loop->stop()` is
sufficient given `Tick` has no `stop()`), not the *what*.
