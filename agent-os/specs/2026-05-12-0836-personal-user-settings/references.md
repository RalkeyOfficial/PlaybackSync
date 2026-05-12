# References for Personal User Settings

## Similar Implementations

### Admin Settings (template to mirror)

- **Backend controller**: `lib/Controller/AdminSettingsController.php`
- **Routes**: `appinfo/routes.php` (the `admin_settings#*` block)
- **Frontend service**: `src/services/adminSettingsApi.ts`
- **Pinia store**: `src/stores/adminSettings.ts`
- **View**: `src/views/AdminSettings.vue`
- **Types**: `src/types/adminSettings.ts`
- **Relevance**: A working end-to-end pattern for typed settings — REST snapshot + flat patch, server-side validation with INT_RULES / INT_DEFAULTS / `coerceInt`, axios via `@nextcloud/axios`, Pinia store with `loaded`/`loading`/`saving` flags, and `extractErrorMessage` helper that surfaces server validation messages in toasts.
- **Key patterns to borrow**:
  - Constructor injection (PHP) and `private const INT_RULES` / `INT_DEFAULTS` shape
  - The `snapshot()` method that builds the response payload
  - The `validate()` / `coerceInt()` pair that rejects unknown keys and out-of-range numeric values
  - The `apiUrl()` helper using `generateUrl('/apps/playbacksync/api/v1/...')`
  - The store's `applySnapshot`, `saveSection`, and `extractErrorMessage` pattern

### Auto-refresh composable

- **Location**: `src/composables/useAutoRefresh.ts`
- **Relevance**: Defines how the interval is consumed. `intervalMs` is captured at setup time and isn't reactive — that informed the decision to remount `AutoRefreshRing` via `:key="autoRefreshIntervalMs"` when the user saves a new value, rather than refactor the composable.

### Modal pattern

- **Location**: `src/components/RoomDetailDialog.vue`, `src/components/RoomCreateDialog.vue`, `src/components/RoomCreatedDialog.vue`
- **Relevance**: Project-standard `NcDialog` use — `:open` + `@update:open` two-way binding (or `v-model:open` shorthand), `size="normal"`, scoped styles. New `UserSettingsDialog.vue` follows the same shape.

### Rooms panel layout

- **Location**: `src/components/RoomsPanel.vue`
- **Relevance**: Flex-column container we're extending with a new footer row.
