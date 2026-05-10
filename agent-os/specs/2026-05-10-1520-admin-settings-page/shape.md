# Admin Settings Page — Shaping Notes

## Scope

Add a Nextcloud admin settings page at `/index.php/settings/admin/playbacksync` exposing every backend tunable. Page is registered as `<admin>` + `<admin-section>` only — not added to the regular app navigation. Promote `MAX_TTL_SECONDS` and `MAX_CLIENTS_PER_ROOM` from PHP constants to `IAppConfig` so they become tunable. Admin secret rotation is included via a confirm-before-rotate flow.

## Decisions

- Single page, four `NcSettingsSection` groups: WS Tuning, Daemon Binding, Rooms, Security.
- Each section has its own scoped Save button.
- Hydration: API on mount (no `IInitialState`) — matches openregister.
- Vite gets a second entry `adminSettings` → bundle `playbacksync-adminSettings.mjs`.
- Daemon-binding changes show a NoteCard warning that the WS daemon must be restarted.
- Admin secret never round-trips in plaintext to the client; only a masked form is exposed.
- Promoted config keys: `max_ttl_seconds` (default 86400), `max_clients_per_room` (default 50).
- Routes under `/api/v1/admin/settings` to match the existing `/api/v1/...` prefix.

## Context

- Visuals: None.
- References: openregister at `/home/ralkey/nextcloud-docker-dev/workspace/server/apps-extra/openregister/`.
- Product alignment: N/A (no product folder).

## Standards Applied

- backend/php-conventions — controller/migration/service classes, strict types, OCP imports.
- frontend/vue-conventions — `<script setup>`, Pinia, `@nextcloud/vue` components, l10n.
- tooling/build — Vite multi-entry, npm scripts.

## Localization keys (with Dutch)

| English | Dutch |
|---|---|
| Administration | Beheer |
| WebSocket sync tuning | WebSocket-synchronisatie afstemming |
| Daemon binding | Daemonbinding |
| Room defaults | Standaardinstellingen voor kamers |
| Security | Beveiliging |
| Save | Opslaan |
| Saved | Opgeslagen |
| Could not save settings. | Kon instellingen niet opslaan. |
| Could not load settings. | Kon instellingen niet laden. |
| Join timeout (ms) | Time-out voor deelname (ms) |
| Idle close (ms) | Sluiten bij inactiviteit (ms) |
| Tombstone (ms) | Tombstone (ms) |
| Kick block (ms) | Blokkeerduur na loskoppelen (ms) |
| Event log size | Grootte gebeurtenislogboek |
| Rate limit (events/s) | Snelheidslimiet (events/s) |
| Drift nudge threshold (ms) | Drempel voor drift-correctie (ms) |
| Drift seek threshold (ms) | Drempel voor drift-seek (ms) |
| Drift cooldown (ms) | Drift-afkoeltijd (ms) |
| WebSocket host | WebSocket-host |
| WebSocket port | WebSocket-poort |
| Admin host | Beheerhost |
| Admin port | Beheerpoort |
| Changing the daemon host or port requires restarting the WebSocket daemon (occ playbacksync:ws-serve) before it takes effect. | Het wijzigen van de host of poort vereist een herstart van de WebSocket-daemon (occ playbacksync:ws-serve) voordat het van kracht wordt. |
| Restrict room creation to administrators | Beperk het aanmaken van kamers tot beheerders |
| Default room TTL (seconds) | Standaard TTL voor kamers (seconden) |
| Maximum room TTL (seconds) | Maximale TTL voor kamers (seconden) |
| Maximum clients per room | Maximaal aantal cliënten per kamer |
| Admin shared secret | Gedeeld beheergeheim |
| Reveal | Tonen |
| Hide | Verbergen |
| Copy | Kopiëren |
| Regenerate | Opnieuw genereren |
| Regenerate admin secret? | Beheergeheim opnieuw genereren? |
| This will rotate the admin secret. The running WebSocket daemon will continue to use the old secret until it is restarted — admin endpoints will fail in the meantime. Continue? | Hiermee wordt het beheergeheim geroteerd. De draaiende WebSocket-daemon blijft het oude geheim gebruiken totdat deze opnieuw wordt gestart — beheerendpoints zullen ondertussen falen. Doorgaan? |
| Admin secret regenerated | Beheergeheim opnieuw gegenereerd |
| Could not regenerate admin secret. | Kon beheergeheim niet opnieuw genereren. |
| Secret copied | Geheim gekopieerd |
