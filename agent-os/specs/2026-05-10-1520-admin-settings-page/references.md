# References

## openregister admin settings

- **Location:** `/home/ralkey/nextcloud-docker-dev/workspace/server/apps-extra/openregister/`
- **Relevance:** same Nextcloud-app admin-page pattern we are replicating.
- **Key files:**
  - `appinfo/info.xml` — `<settings>` registration shape.
  - `lib/Sections/OpenRegisterAdmin.php` — `IIconSection`.
  - `lib/Settings/OpenRegisterAdmin.php` — `ISettings.getForm()` returning `TemplateResponse(..., 'admin')`.
  - `templates/settings/admin.php` — minimal mount-point template.
  - `src/settings.js` — Vue+Pinia entry for the admin bundle.
  - `lib/Controller/SettingsController.php` + `appinfo/routes.php` — REST endpoints persisting via `IAppConfig`.

## Internal patterns to mirror

- `src/services/roomsApi.ts` for axios shape.
- `src/stores/rooms.ts` for Pinia store conventions.
- `src/components/RoomCreateDialog.vue` for `NcTextField type="number"` + validation.
- `src/components/RoomDetailDialog.vue` for `NcDialog` confirm-before-action and clipboard helper.
- `lib/Migration/EnsureAdminSecret.php` for the secret-generation pattern (extracted into `AdminSecretService` for shared use).
