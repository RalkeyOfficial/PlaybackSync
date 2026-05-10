# Standards for WS daemon healthcheck

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

> Note for this spec: existing controllers in `lib/Controller/` use the **attribute** form (`#[NoAdminRequired]` from `OCP\AppFramework\Http\Attribute\NoAdminRequired`) rather than PHPDoc tags. The new `HealthController` follows the existing in-repo precedent and uses `#[PublicPage]` + `#[NoCSRFRequired]` attributes.

---

## Admin-endpoint precedent (kick spec)

The most recent admin-loopback endpoint (`agent-os/specs/2026-05-10-1415-connected-client-kick/`) sets the structural pattern this work mirrors:

- **Daemon side**: a small controller (`KickController`) that does pure value transformation around `RoomRegistry` lookups. HTTP wiring lives entirely in `PresenceHttpServer`.
- **PHP side**: a thin loopback HTTP client beside `PresenceClient` / `AdminKickClient` — one method, one URL, one timeout.

Differences for `/healthz`:

- **No HMAC**. Daemon `/healthz` is unauthenticated (loopback + no sensitive data); the PHP client therefore omits the `X-PBSync-Admin` header.
- **No exceptions**. Healthcheck callers never want a 5xx — failure modes collapse to `daemon.reachable=false` in the response body, mirroring `PresenceClient` rather than `AdminKickClient`.
