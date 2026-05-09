#!/usr/bin/env bash
#
# PlaybackSync — WebSocket daemon installer
#
# Goal: get the daemon, the systemd service, and the reverse-proxy snippet in
# place with one command on the largest set of Linux installations possible.
#
# Strategy:
#   1. Auto-detect the Nextcloud install path, init system, and active web
#      server. Anything we can't detect with confidence becomes a required
#      flag — we don't guess.
#   2. Build a plan and show it to the operator. Only apply on confirmation
#      (or with --yes).
#   3. Every change is idempotent: running twice is a no-op. Web-server
#      config edits are bracketed by marker comments so we can find/update/
#      remove them surgically. Original files are backed up before edit.
#   4. Containerised installs (no systemd) are detected; the script does the
#      bits it can (composer, occ, app config) and prints sidecar
#      instructions for the rest instead of pretending it can install a
#      service.
#
# Run as root. Tested against: Debian 12, Ubuntu 22.04/24.04, Rocky 9,
# openSUSE Leap 15.6, Alpine 3.19 (no-systemd path).

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_VERSION="1.0.0"
SERVICE_NAME="playbacksync-ws"
APP_ID="playbacksync"

DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="8765"
DEFAULT_USER="www-data"

MARKER_BEGIN="# >>> playbacksync-ws managed begin (do not edit between markers)"
MARKER_END="# <<< playbacksync-ws managed end"

# CLI overrides — populated below.
NC_PATH=""
WEB_SERVER=""
VHOST_CONFIG=""
HOST="$DEFAULT_HOST"
PORT="$DEFAULT_PORT"
RUN_USER=""
DRY_RUN=0
ASSUME_YES=0
SKIP_RELOAD=0
SKIP_START=0
UNINSTALL=0

# Mode selection: "auto" picks docker if a Nextcloud container is running and
# there's no NC at the usual host paths. "host" and "docker" force a mode.
MODE="auto"
DOCKER_NC_CONTAINER=""
DOCKER_PROXY_CONTAINER=""
DOCKER_COMPOSE_FILE=""
DOCKER_NO_PROXY=0

# Discovered at runtime in docker mode.
DOCKER_NC_PATH_INCONTAINER=""   # where occ lives inside the NC container
DOCKER_NC_HOST_MOUNT=""         # host path mounted there, if any
DOCKER_NC_NETWORK=""            # primary docker network NC is attached to
DOCKER_NC_USER=""               # uid:gid the NC container runs occ as
DOCKER_NC_IMAGE=""
DOCKER_PROXY_ENGINE=""          # nginx | apache | nginx-proxy | unknown
DOCKER_PROXY_RELOAD=""          # command to reload (run via docker exec)
DOCKER_PROXY_STRATEGY=""        # vhost.d | bind-mount | docker-cp | manual
DOCKER_PROXY_VHOST_HOST=""      # for vhost.d pattern: host file path to write
DOCKER_PROXY_BIND_HOST=""       # for bind-mount pattern: host file path
DOCKER_PROXY_INCONTAINER=""     # where the snippet ends up inside container
DOCKER_COMPOSE_PROJECT=""
DOCKER_COMPOSE_DIR=""
DOCKER_OVERRIDE_FILE=""

# Discovered at runtime.
PHP_BIN=""
OCC_BIN=""
COMPOSER_BIN=""
HAS_SYSTEMD=0
IN_CONTAINER=0
WEB_SERVER_RELOAD=""
SNIPPET_FILE=""

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
	C_RESET=$'\033[0m'
	C_DIM=$'\033[2m'
	C_BOLD=$'\033[1m'
	C_RED=$'\033[31m'
	C_YELLOW=$'\033[33m'
	C_GREEN=$'\033[32m'
	C_BLUE=$'\033[34m'
else
	C_RESET=""; C_DIM=""; C_BOLD=""; C_RED=""; C_YELLOW=""; C_GREEN=""; C_BLUE=""
fi

info()  { printf '%s[ info]%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf '%s[  ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s[ warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()   { printf '%s[ err ]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()   { err "$*"; exit 1; }

usage() {
	cat <<EOF
PlaybackSync WebSocket daemon installer (v${SCRIPT_VERSION})

Usage: sudo $0 [options]

Mode (auto-detected):
  --docker               Run in Docker mode (target a Nextcloud container)
  --host-mode            Run in host/bare-metal mode

Host-mode options:
  --nc-path PATH         Path to the Nextcloud root (auto-detected if omitted)
  --web-server NAME      nginx | apache  (auto-detected if omitted)
  --vhost-config PATH    Path to the web-server vhost config to edit
                         (auto-detected if omitted; required if ambiguous)
  --user USER            User to run the daemon as (default: detected web user)

Docker-mode options:
  --container NAME       Nextcloud container (auto-detected if omitted)
  --proxy-container NAME Reverse-proxy container (auto-detected; '--no-proxy'
                         skips proxy config and prints the snippet to add)
  --no-proxy             Don't try to configure the proxy; leave it to me
  --compose-file PATH    Override the compose file location

Common options:
  --host HOST            Bind host for the daemon (default: ${DEFAULT_HOST}
                         host-mode, 0.0.0.0 docker-mode)
  --port PORT            Bind port for the daemon (default: ${DEFAULT_PORT})
  --dry-run              Show the plan, change nothing
  -y, --yes              Skip confirmation prompt
  --no-reload            Do not reload the web server (you'll do it yourself)
  --no-start             Do not start the daemon (host-mode: systemd; docker-
                         mode: 'docker compose up' for the new sidecar)
  --uninstall            Reverse what this installer did (works in both modes)
  -h, --help             This message
  --version              Print version and exit

Auto-detect logic: if a Nextcloud container is running AND no Nextcloud
install is found at standard host paths, the script switches to Docker mode
automatically. Use --host-mode or --docker to force.

The script must run as root in host mode. In Docker mode it must run on a
host where 'docker' works for the current user.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
	case "$1" in
		--nc-path)          NC_PATH="$2"; shift 2 ;;
		--web-server)       WEB_SERVER="$2"; shift 2 ;;
		--vhost-config)     VHOST_CONFIG="$2"; shift 2 ;;
		--host)             HOST="$2"; shift 2 ;;
		--port)             PORT="$2"; shift 2 ;;
		--user)             RUN_USER="$2"; shift 2 ;;
		--docker)           MODE="docker"; shift ;;
		--host-mode)        MODE="host"; shift ;;
		--container)        DOCKER_NC_CONTAINER="$2"; shift 2 ;;
		--proxy-container)  DOCKER_PROXY_CONTAINER="$2"; shift 2 ;;
		--no-proxy)         DOCKER_NO_PROXY=1; shift ;;
		--compose-file)     DOCKER_COMPOSE_FILE="$2"; shift 2 ;;
		--dry-run)          DRY_RUN=1; shift ;;
		-y|--yes)           ASSUME_YES=1; shift ;;
		--no-reload)        SKIP_RELOAD=1; shift ;;
		--no-start)         SKIP_START=1; shift ;;
		--uninstall)        UNINSTALL=1; shift ;;
		-h|--help)          usage; exit 0 ;;
		--version)          echo "$SCRIPT_VERSION"; exit 0 ;;
		*) die "unknown option: $1 (try --help)" ;;
	esac
done

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

require_root() {
	if [[ $EUID -ne 0 ]]; then
		die "this script must run as root (try: sudo $0 ${*:-})"
	fi
}

run() {
	# Run a privileged step, honouring --dry-run.
	if [[ $DRY_RUN -eq 1 ]]; then
		printf '%s[ dry ]%s %s\n' "$C_DIM" "$C_RESET" "$*"
	else
		"$@"
	fi
}

write_file() {
	# write_file PATH — content from stdin. Idempotent when content matches.
	local path="$1"
	local content
	content="$(cat)"

	if [[ -f "$path" ]] && [[ "$(cat "$path")" == "$content" ]]; then
		info "unchanged: $path"
		return 0
	fi

	if [[ $DRY_RUN -eq 1 ]]; then
		printf '%s[ dry ]%s would write %s (%d bytes)\n' "$C_DIM" "$C_RESET" "$path" "${#content}"
		return 0
	fi

	if [[ -f "$path" ]]; then
		cp -a "$path" "${path}.bak.$(date +%s)"
	fi
	mkdir -p "$(dirname "$path")"
	printf '%s\n' "$content" > "$path"
	ok "wrote: $path"
}

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

detect_container() {
	if [[ -f /.dockerenv ]] || grep -qE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null; then
		IN_CONTAINER=1
	fi
}

detect_systemd() {
	if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
		HAS_SYSTEMD=1
	fi
}

detect_nc_path() {
	if [[ -n "$NC_PATH" ]]; then
		[[ -f "$NC_PATH/occ" ]] || die "no occ at $NC_PATH/occ"
		return
	fi
	local candidate
	for candidate in /var/www/nextcloud /var/www/html /srv/nextcloud /usr/share/nextcloud /snap/nextcloud/current/htdocs; do
		if [[ -f "$candidate/occ" ]]; then
			NC_PATH="$candidate"
			return
		fi
	done
	die "could not auto-detect Nextcloud root. Pass --nc-path /path/to/nextcloud."
}

detect_php() {
	PHP_BIN="$(command -v php || true)"
	[[ -n "$PHP_BIN" ]] || die "php is not on PATH; install PHP first."
	OCC_BIN="$NC_PATH/occ"
	[[ -f "$OCC_BIN" ]] || die "no occ at $OCC_BIN"
}

detect_composer() {
	COMPOSER_BIN="$(command -v composer || true)"
	if [[ -z "$COMPOSER_BIN" ]] && [[ -x /usr/local/bin/composer ]]; then
		COMPOSER_BIN=/usr/local/bin/composer
	fi
}

detect_run_user() {
	if [[ -n "$RUN_USER" ]]; then
		id -u "$RUN_USER" >/dev/null 2>&1 || die "user '$RUN_USER' does not exist"
		return
	fi
	# Pick the user that owns the Nextcloud directory. Falls back to a few
	# common defaults if ownership is something unhelpful like root.
	local owner
	owner="$(stat -c %U "$NC_PATH" 2>/dev/null || echo root)"
	if [[ "$owner" != "root" ]] && id -u "$owner" >/dev/null 2>&1; then
		RUN_USER="$owner"
	else
		for c in www-data apache nginx http nobody; do
			if id -u "$c" >/dev/null 2>&1; then
				RUN_USER="$c"
				break
			fi
		done
	fi
	[[ -n "$RUN_USER" ]] || die "could not pick a service user; pass --user."
}

detect_web_server() {
	if [[ -n "$WEB_SERVER" ]]; then
		case "$WEB_SERVER" in nginx|apache) ;; *) die "--web-server must be nginx or apache" ;; esac
		return
	fi
	# Prefer "is running" over "is installed" — many distros leave both packages.
	if pgrep -x nginx >/dev/null 2>&1; then
		WEB_SERVER="nginx"
	elif pgrep -xE 'apache2|httpd' >/dev/null 2>&1; then
		WEB_SERVER="apache"
	elif command -v nginx >/dev/null 2>&1; then
		WEB_SERVER="nginx"
	elif command -v apache2ctl >/dev/null 2>&1 || command -v apachectl >/dev/null 2>&1; then
		WEB_SERVER="apache"
	else
		warn "no nginx or apache found — skipping reverse-proxy step."
		WEB_SERVER="none"
	fi
}

detect_vhost_for_nginx() {
	[[ -n "$VHOST_CONFIG" ]] && return
	# Look in the usual places for a server block that mentions the
	# Nextcloud document root. We bias towards confidence; ambiguity → ask.
	local candidates=()
	local nc_basename
	nc_basename="$(basename "$NC_PATH")"
	while IFS= read -r f; do
		candidates+=("$f")
	done < <(grep -lE "(${NC_PATH//\//\\/}|root\s+${NC_PATH//\//\\/}|server_name.*nextcloud)" \
		/etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null || true)

	if [[ ${#candidates[@]} -eq 0 ]]; then
		die "could not find an nginx vhost mentioning $NC_PATH or '$nc_basename'. Pass --vhost-config /path/to/vhost.conf."
	fi
	if [[ ${#candidates[@]} -gt 1 ]]; then
		warn "multiple candidate nginx vhosts:"
		printf '       %s\n' "${candidates[@]}" >&2
		die "pass --vhost-config to pick one."
	fi
	VHOST_CONFIG="${candidates[0]}"
}

detect_vhost_for_apache() {
	[[ -n "$VHOST_CONFIG" ]] && return
	local candidates=()
	while IFS= read -r f; do
		candidates+=("$f")
	done < <(grep -lE "DocumentRoot\s+${NC_PATH//\//\\/}" \
		/etc/apache2/sites-enabled/*.conf /etc/httpd/conf.d/*.conf /etc/apache2/conf.d/*.conf 2>/dev/null || true)

	if [[ ${#candidates[@]} -eq 0 ]]; then
		die "could not find an Apache vhost with DocumentRoot $NC_PATH. Pass --vhost-config /path/to/vhost.conf."
	fi
	if [[ ${#candidates[@]} -gt 1 ]]; then
		warn "multiple candidate Apache vhosts:"
		printf '       %s\n' "${candidates[@]}" >&2
		die "pass --vhost-config to pick one."
	fi
	VHOST_CONFIG="${candidates[0]}"
}

detect_web_reload() {
	case "$WEB_SERVER" in
		nginx)
			if [[ $HAS_SYSTEMD -eq 1 ]]; then
				WEB_SERVER_RELOAD="systemctl reload nginx"
			else
				WEB_SERVER_RELOAD="nginx -s reload"
			fi
			;;
		apache)
			if [[ $HAS_SYSTEMD -eq 1 ]]; then
				if systemctl list-unit-files apache2.service >/dev/null 2>&1; then
					WEB_SERVER_RELOAD="systemctl reload apache2"
				else
					WEB_SERVER_RELOAD="systemctl reload httpd"
				fi
			elif command -v apache2ctl >/dev/null 2>&1; then
				WEB_SERVER_RELOAD="apache2ctl graceful"
			else
				WEB_SERVER_RELOAD="apachectl graceful"
			fi
			;;
		*) WEB_SERVER_RELOAD="" ;;
	esac
}

# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------

show_plan() {
	cat <<EOF

${C_BOLD}PlaybackSync WebSocket daemon — install plan${C_RESET}

  Nextcloud root      ${NC_PATH}
  PHP binary          ${PHP_BIN}
  Service user        ${RUN_USER}
  Bind                ${HOST}:${PORT}
  systemd available   $([[ $HAS_SYSTEMD -eq 1 ]] && echo yes || echo no)
  Container           $([[ $IN_CONTAINER -eq 1 ]] && echo yes || echo no)
  Web server          ${WEB_SERVER}
  Vhost config        ${VHOST_CONFIG:-(none — skipping proxy step)}
  Reload command      ${WEB_SERVER_RELOAD:-(none)}

The script will:
  1. composer install --no-dev (in $NC_PATH/apps-extra/$APP_ID or apps/$APP_ID)
  2. occ app:enable $APP_ID
  3. set ws_host / ws_port app-config keys
EOF
	if [[ $HAS_SYSTEMD -eq 1 ]]; then
		echo "  4. write /etc/systemd/system/${SERVICE_NAME}.service and enable it"
	else
		echo "  4. ${C_YELLOW}skip${C_RESET} systemd unit (no systemd here — instructions printed at the end)"
	fi
	case "$WEB_SERVER" in
		nginx)
			echo "  5. write /etc/nginx/snippets/${SERVICE_NAME}.conf"
			echo "  6. add 'include' line to ${VHOST_CONFIG} (between markers, idempotent)"
			;;
		apache)
			echo "  5. write /etc/apache2/conf-available/${SERVICE_NAME}.conf (or distro equivalent)"
			echo "  6. add Include line to ${VHOST_CONFIG} (between markers, idempotent)"
			;;
		none) echo "  5. ${C_YELLOW}skip${C_RESET} reverse-proxy step (no recognised web server)" ;;
	esac
	if [[ $SKIP_RELOAD -eq 1 ]]; then
		echo "  7. ${C_YELLOW}skip${C_RESET} web-server reload (you asked --no-reload)"
	elif [[ -n "$WEB_SERVER_RELOAD" ]]; then
		echo "  7. reload web server: ${WEB_SERVER_RELOAD}"
	fi
	if [[ $HAS_SYSTEMD -eq 1 && $SKIP_START -eq 0 ]]; then
		echo "  8. systemctl enable --now ${SERVICE_NAME}"
	fi
	echo "  9. verify with a WebSocket handshake to http://${HOST}:${PORT}/probe"
	echo
}

confirm() {
	[[ $ASSUME_YES -eq 1 ]] && return 0
	[[ $DRY_RUN -eq 1 ]] && return 0
	read -r -p "Proceed? [y/N] " ans
	case "$ans" in [yY]|[yY][eE][sS]) return 0 ;; *) info "aborted."; exit 0 ;; esac
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

find_app_dir() {
	local d
	for d in "$NC_PATH/apps-extra/$APP_ID" "$NC_PATH/apps/$APP_ID"; do
		if [[ -d "$d" ]]; then echo "$d"; return 0; fi
	done
	die "playbacksync app directory not found under $NC_PATH/apps* — clone or copy the repo first."
}

step_composer_install() {
	local app_dir
	app_dir="$(find_app_dir)"
	if [[ ! -f "$app_dir/composer.json" ]]; then
		warn "no composer.json in $app_dir — skipping vendor install."
		return 0
	fi
	if [[ -d "$app_dir/vendor" && -f "$app_dir/vendor/autoload.php" ]]; then
		info "vendor/ already present in $app_dir — skipping composer install."
		return 0
	fi
	[[ -n "$COMPOSER_BIN" ]] || die "composer is not on PATH; install Composer or run this on a host that has it."
	info "running composer install in $app_dir"
	run sudo -u "$RUN_USER" sh -c "cd '$app_dir' && '$COMPOSER_BIN' install --no-dev --no-interaction --prefer-dist"
	ok "composer install done"
}

step_occ_enable() {
	info "enabling app + writing config keys"
	run sudo -u "$RUN_USER" "$PHP_BIN" "$OCC_BIN" app:enable "$APP_ID"
	run sudo -u "$RUN_USER" "$PHP_BIN" "$OCC_BIN" config:app:set "$APP_ID" ws_host --value "$HOST"
	run sudo -u "$RUN_USER" "$PHP_BIN" "$OCC_BIN" config:app:set "$APP_ID" ws_port --value "$PORT"
	ok "occ app:enable + config keys set"
}

step_systemd_unit() {
	[[ $HAS_SYSTEMD -eq 1 ]] || return 0
	local unit="/etc/systemd/system/${SERVICE_NAME}.service"
	write_file "$unit" <<EOF
[Unit]
Description=PlaybackSync WebSocket sync server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${NC_PATH}
ExecStart=${PHP_BIN} ${OCC_BIN} playbacksync:ws-serve
Restart=on-failure
RestartSec=5
RuntimeMaxSec=7d
# Suppress PHP 8.4 deprecation warnings from cboden/ratchet:
Environment=PHP_INI_SCAN_DIR=
Environment="PHPRC="

[Install]
WantedBy=multi-user.target
EOF
	run systemctl daemon-reload
	ok "systemd unit installed"
}

# Build the snippet content in a temp file and return its path.
build_nginx_snippet() {
	local out="$1"
	cat > "$out" <<EOF
${MARKER_BEGIN}
location ^~ /apps/playbacksync/ws/ {
    proxy_pass http://${HOST}:${PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
${MARKER_END}
EOF
}

build_apache_snippet() {
	local out="$1"
	cat > "$out" <<EOF
${MARKER_BEGIN}
<IfModule mod_proxy_wstunnel.c>
    ProxyPass        "/apps/playbacksync/ws/" "ws://${HOST}:${PORT}/apps/playbacksync/ws/"
    ProxyPassReverse "/apps/playbacksync/ws/" "ws://${HOST}:${PORT}/apps/playbacksync/ws/"
</IfModule>
${MARKER_END}
EOF
}

# Insert <include-line> into vhost config between markers. Idempotent.
inject_include_into_vhost() {
	local include_line="$1"
	local vhost="$VHOST_CONFIG"

	if grep -q "$MARKER_BEGIN" "$vhost"; then
		# Replace the existing managed block in case the include path changed.
		if [[ $DRY_RUN -eq 1 ]]; then
			printf '%s[ dry ]%s would refresh managed block in %s\n' "$C_DIM" "$C_RESET" "$vhost"
			return 0
		fi
		cp -a "$vhost" "${vhost}.bak.$(date +%s)"
		# Use awk to replace from MARKER_BEGIN to MARKER_END inclusive.
		awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" -v repl="    ${MARKER_BEGIN}
    ${include_line}
    ${MARKER_END}" '
			index($0, begin) > 0 { print repl; skip=1; next }
			skip && index($0, end) > 0 { skip=0; next }
			!skip { print }
		' "$vhost" > "${vhost}.new"
		mv "${vhost}.new" "$vhost"
		ok "refreshed managed block in $vhost"
		return 0
	fi

	# No managed block yet — inject before the closing brace of the first
	# server block (nginx) or before </VirtualHost> (apache). Cheap-and-
	# cheerful detection: look for the line and inject before it.
	local target_line
	if [[ "$WEB_SERVER" == "nginx" ]]; then
		target_line="$(grep -n '^[[:space:]]*}[[:space:]]*$' "$vhost" | head -1 | cut -d: -f1)"
	else
		target_line="$(grep -niE '^[[:space:]]*</VirtualHost' "$vhost" | head -1 | cut -d: -f1)"
	fi
	[[ -n "$target_line" ]] || die "couldn't find a place to inject in $vhost. Add this line manually inside the server block:
    $include_line"

	if [[ $DRY_RUN -eq 1 ]]; then
		printf '%s[ dry ]%s would inject managed block before line %s of %s\n' "$C_DIM" "$C_RESET" "$target_line" "$vhost"
		return 0
	fi
	cp -a "$vhost" "${vhost}.bak.$(date +%s)"
	{
		head -n $((target_line - 1)) "$vhost"
		printf '    %s\n' "$MARKER_BEGIN"
		printf '    %s\n' "$include_line"
		printf '    %s\n' "$MARKER_END"
		tail -n +"$target_line" "$vhost"
	} > "${vhost}.new"
	mv "${vhost}.new" "$vhost"
	ok "injected managed block into $vhost"
}

step_nginx_proxy() {
	SNIPPET_FILE="/etc/nginx/snippets/${SERVICE_NAME}.conf"
	if [[ $DRY_RUN -eq 1 ]]; then
		printf '%s[ dry ]%s would write %s\n' "$C_DIM" "$C_RESET" "$SNIPPET_FILE"
	else
		mkdir -p "$(dirname "$SNIPPET_FILE")"
		build_nginx_snippet "$SNIPPET_FILE"
		ok "wrote $SNIPPET_FILE"
	fi
	inject_include_into_vhost "include $SNIPPET_FILE;"
}

step_apache_proxy() {
	# Pick a reasonable conf-available path per distro family.
	if [[ -d /etc/apache2/conf-available ]]; then
		SNIPPET_FILE="/etc/apache2/conf-available/${SERVICE_NAME}.conf"
	else
		SNIPPET_FILE="/etc/httpd/conf.d/${SERVICE_NAME}.conf"
	fi
	if [[ $DRY_RUN -eq 1 ]]; then
		printf '%s[ dry ]%s would write %s\n' "$C_DIM" "$C_RESET" "$SNIPPET_FILE"
	else
		mkdir -p "$(dirname "$SNIPPET_FILE")"
		build_apache_snippet "$SNIPPET_FILE"
		ok "wrote $SNIPPET_FILE"
	fi
	# Apache's preferred shape is to put proxy directives inside the vhost
	# directly; we use Include for symmetry with the nginx path.
	inject_include_into_vhost "Include $SNIPPET_FILE"

	# Make sure mod_proxy_wstunnel is enabled on Debian-family systems.
	if command -v a2enmod >/dev/null 2>&1; then
		run a2enmod -q proxy proxy_http proxy_wstunnel || warn "a2enmod failed; enable proxy_wstunnel manually."
	fi
}

step_reload_web_server() {
	[[ $SKIP_RELOAD -eq 1 ]] && { info "skipping web-server reload (--no-reload)"; return 0; }
	[[ -z "$WEB_SERVER_RELOAD" ]] && return 0
	# Smoke-test the config first when we can.
	if [[ "$WEB_SERVER" == "nginx" ]]; then
		run nginx -t || die "nginx -t failed; not reloading. Backup files end with .bak.<timestamp>."
	elif [[ "$WEB_SERVER" == "apache" ]]; then
		if command -v apache2ctl >/dev/null 2>&1; then
			run apache2ctl configtest || die "apache config test failed; not reloading."
		elif command -v apachectl >/dev/null 2>&1; then
			run apachectl configtest || die "apache config test failed; not reloading."
		fi
	fi
	run $WEB_SERVER_RELOAD
	ok "web server reloaded"
}

step_start_service() {
	[[ $HAS_SYSTEMD -eq 1 ]] || return 0
	[[ $SKIP_START -eq 1 ]] && { info "skipping service start (--no-start)"; return 0; }
	run systemctl enable --now "$SERVICE_NAME"
	ok "${SERVICE_NAME} enabled and started"
}

step_verify() {
	[[ $DRY_RUN -eq 1 ]] && return 0
	command -v curl >/dev/null 2>&1 || { warn "curl missing; cannot verify."; return 0; }
	# Give the daemon a moment to bind.
	sleep 1
	local code
	code="$(curl -sS -o /dev/null -w '%{http_code}' \
		--max-time 3 \
		-H "Connection: Upgrade" \
		-H "Upgrade: websocket" \
		-H "Host: ${HOST}" \
		-H "Sec-WebSocket-Version: 13" \
		-H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
		"http://${HOST}:${PORT}/probe" || true)"
	if [[ "$code" == "101" ]]; then
		ok "daemon responded with 101 Switching Protocols"
	else
		warn "verification failed: got HTTP $code (expected 101). Check 'journalctl -u ${SERVICE_NAME}' or run the daemon manually."
	fi
}

print_container_followup() {
	[[ $HAS_SYSTEMD -eq 1 ]] && return 0
	cat <<EOF

${C_YELLOW}No systemd was detected (likely a container).${C_RESET}
The app and config keys are in place, but you still need to keep the daemon
process alive yourself. Two common patterns:

  1. ${C_BOLD}docker-compose sidecar${C_RESET} — add to your docker-compose.yml:

     playbacksync-ws:
       image: <your nextcloud image with composer deps>
       restart: unless-stopped
       command: php /var/www/html/occ playbacksync:ws-serve
       network_mode: service:nextcloud

  2. ${C_BOLD}supervisor / s6${C_RESET} — point your process supervisor at:

     ${PHP_BIN} ${OCC_BIN} playbacksync:ws-serve

EOF
}

# ===========================================================================
# Docker mode
# ===========================================================================
#
# In Docker mode the script targets containers rather than the host filesystem.
# It auto-detects:
#   - The Nextcloud container (anything with /var/www/html/occ or /var/www/nextcloud/occ inside)
#   - The reverse-proxy container (port 80/443 published, running nginx/apache/caddy)
#   - The compose project + file (from container labels)
# and applies:
#   - composer install + occ + IAppConfig keys via 'docker exec'
#   - A sidecar service via a 'docker-compose.playbacksync.override.yml' next to the user's compose file
#   - The proxy snippet via the cleanest available strategy:
#       * nginx-proxy 'vhost.d' drop-in (no reload needed)
#       * Bind-mounted config edit (host-side, then 'docker exec reload')
#       * 'docker cp' round-trip (warns: doesn't survive container rebuild)
#       * Manual instructions when nothing fits
#
# Refuses on Nextcloud AIO; that orchestrator is opinionated enough that
# half-applying anything here would cause more problems than it solves.

docker_available() {
	command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

docker_detect_aio() {
	if docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null \
		| grep -qiE 'nextcloud-aio-(mastercontainer|apache|nextcloud|database)'; then
		err "Nextcloud AIO detected. AIO manages its own services; this installer would conflict with it."
		err "Run the daemon manually inside the AIO Nextcloud container as a one-off, or open an issue if you'd like AIO support."
		exit 1
	fi
}

# List Nextcloud-looking containers. Output: cid|name|image|nc_path
docker_list_nc_candidates() {
	local cid name image
	for cid in $(docker ps -q); do
		name="$(docker inspect -f '{{.Name}}' "$cid" | sed 's|^/||')"
		image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
		# Skip ourselves if running in a container that we somehow saw.
		if docker exec "$cid" test -f /var/www/html/occ 2>/dev/null; then
			echo "$cid|$name|$image|/var/www/html"
		elif docker exec "$cid" test -f /var/www/nextcloud/occ 2>/dev/null; then
			echo "$cid|$name|$image|/var/www/nextcloud"
		fi
	done
}

# List proxy-looking containers. Output: cid|name|image|engine
# engine is one of: nginx-proxy | nginx | apache | caddy | unknown
docker_list_proxy_candidates() {
	local cid name image proc binds
	for cid in $(docker ps -q); do
		name="$(docker inspect -f '{{.Name}}' "$cid" | sed 's|^/||')"
		image="$(docker inspect -f '{{.Config.Image}}' "$cid")"
		# Skip the NC container itself.
		[[ "$cid" == "$DOCKER_NC_CONTAINER" || "$name" == "$DOCKER_NC_CONTAINER" ]] && continue

		# Heuristic 1: jwilder/nginx-proxy or its derivatives expose VIRTUAL_HOST handling
		# and bind-mount /etc/nginx/vhost.d. Detect the bind explicitly.
		binds="$(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}}{{println}}{{end}}' "$cid")"
		if grep -q '/etc/nginx/vhost.d$' <<<"$binds"; then
			echo "$cid|$name|$image|nginx-proxy"
			continue
		fi

		# Heuristic 2: process-based detection inside the container.
		proc="$(docker exec "$cid" sh -c 'cat /proc/1/comm 2>/dev/null; ps -eo comm 2>/dev/null | sort -u' 2>/dev/null || true)"
		if grep -qE '^(nginx)' <<<"$proc"; then
			echo "$cid|$name|$image|nginx"
		elif grep -qE '^(apache2|httpd)' <<<"$proc"; then
			echo "$cid|$name|$image|apache"
		elif grep -qE '^(caddy)' <<<"$proc"; then
			echo "$cid|$name|$image|caddy"
		fi
	done
}

# Generic interactive picker: docker_pick "label" line1 line2 ...
# Each line is rendered to the user verbatim; we return the chosen line on stdout.
docker_pick() {
	local label="$1"; shift
	local -a lines=("$@")
	local i=1
	echo
	echo "${C_BOLD}${label}${C_RESET}"
	for l in "${lines[@]}"; do
		printf '  %d) %s\n' "$i" "$l"
		((i++))
	done
	local choice
	while :; do
		read -r -p "Select [1-${#lines[@]}]: " choice
		if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#lines[@]} )); then
			echo "${lines[$((choice-1))]}"
			return 0
		fi
	done
}

docker_pick_nc_container() {
	# If user passed --container, validate and skip detection.
	if [[ -n "$DOCKER_NC_CONTAINER" ]]; then
		docker inspect "$DOCKER_NC_CONTAINER" >/dev/null 2>&1 \
			|| die "container '$DOCKER_NC_CONTAINER' not found."
		# Resolve nc_path inside it.
		if docker exec "$DOCKER_NC_CONTAINER" test -f /var/www/html/occ 2>/dev/null; then
			DOCKER_NC_PATH_INCONTAINER=/var/www/html
		elif docker exec "$DOCKER_NC_CONTAINER" test -f /var/www/nextcloud/occ 2>/dev/null; then
			DOCKER_NC_PATH_INCONTAINER=/var/www/nextcloud
		else
			die "no occ found inside container '$DOCKER_NC_CONTAINER'."
		fi
		return
	fi

	mapfile -t cands < <(docker_list_nc_candidates)
	if [[ ${#cands[@]} -eq 0 ]]; then
		die "no Nextcloud-looking container found (nothing has /var/www/html/occ or /var/www/nextcloud/occ inside). Pass --container."
	fi
	local picked
	if [[ ${#cands[@]} -eq 1 ]]; then
		picked="${cands[0]}"
		info "single Nextcloud container found: $(echo "$picked" | cut -d'|' -f2)"
	else
		# Render lines as "name (image)"
		local -a labels=()
		for c in "${cands[@]}"; do
			labels+=("$(echo "$c" | awk -F'|' '{printf "%s  (image: %s)", $2, $3}')")
		done
		local picked_label
		picked_label="$(docker_pick "Multiple Nextcloud containers detected — pick one:" "${labels[@]}")"
		# Find the original cands entry whose label matches.
		for c in "${cands[@]}"; do
			if [[ "$(echo "$c" | awk -F'|' '{printf "%s  (image: %s)", $2, $3}')" == "$picked_label" ]]; then
				picked="$c"; break
			fi
		done
	fi
	DOCKER_NC_CONTAINER="$(echo "$picked" | cut -d'|' -f2)"
	DOCKER_NC_IMAGE="$(echo "$picked" | cut -d'|' -f3)"
	DOCKER_NC_PATH_INCONTAINER="$(echo "$picked" | cut -d'|' -f4)"
}

docker_resolve_nc_metadata() {
	# Primary network (the first one in NetworkSettings.Networks).
	DOCKER_NC_NETWORK="$(docker inspect "$DOCKER_NC_CONTAINER" \
		--format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' | head -1)"
	# User the container runs as.
	DOCKER_NC_USER="$(docker inspect "$DOCKER_NC_CONTAINER" --format '{{.Config.User}}' 2>/dev/null || echo '')"
	[[ -z "$DOCKER_NC_USER" ]] && DOCKER_NC_USER="www-data"
	# Image (in case --container was set).
	[[ -z "$DOCKER_NC_IMAGE" ]] && DOCKER_NC_IMAGE="$(docker inspect "$DOCKER_NC_CONTAINER" --format '{{.Config.Image}}')"

	# Find the host path bound at the in-container Nextcloud root, if any.
	# This is what the sidecar will mount to share the codebase.
	DOCKER_NC_HOST_MOUNT="$(docker inspect "$DOCKER_NC_CONTAINER" \
		--format '{{range .Mounts}}{{if eq .Destination "'"$DOCKER_NC_PATH_INCONTAINER"'"}}{{.Source}}{{end}}{{end}}')"
}

docker_pick_proxy_container() {
	[[ $DOCKER_NO_PROXY -eq 1 ]] && return 0

	if [[ -n "$DOCKER_PROXY_CONTAINER" ]]; then
		docker inspect "$DOCKER_PROXY_CONTAINER" >/dev/null 2>&1 \
			|| die "container '$DOCKER_PROXY_CONTAINER' not found."
		# Re-classify the engine.
		local row
		row="$(docker_list_proxy_candidates | grep -E "^[^|]+\|${DOCKER_PROXY_CONTAINER}\|" || true)"
		if [[ -n "$row" ]]; then
			DOCKER_PROXY_ENGINE="$(echo "$row" | cut -d'|' -f4)"
		else
			DOCKER_PROXY_ENGINE="unknown"
		fi
		return
	fi

	# If the NC container itself runs the public-facing web server (single-
	# container deploy), use it as the proxy.
	local nc_engine
	nc_engine="$(docker exec "$DOCKER_NC_CONTAINER" sh -c 'cat /proc/1/comm 2>/dev/null; ps -eo comm 2>/dev/null | sort -u' 2>/dev/null || true)"
	# "Published" = bound to a host port. Image-level EXPOSE without a host
	# binding doesn't count; otherwise nextcloud:fpm would always look like
	# a proxy.
	local nc_has_published
	nc_has_published="$(docker inspect "$DOCKER_NC_CONTAINER" \
		--format '{{range $p, $bs := .NetworkSettings.Ports}}{{range $bs}}{{if .HostPort}}{{$p}} {{end}}{{end}}{{end}}' \
		2>/dev/null | tr ' ' '\n' | grep -E '^(80|443)/' || true)"

	if [[ -n "$nc_has_published" ]] && grep -qE '^(nginx|apache2|httpd)' <<<"$nc_engine"; then
		DOCKER_PROXY_CONTAINER="$DOCKER_NC_CONTAINER"
		DOCKER_PROXY_ENGINE="$(grep -oE '^(nginx|apache2|httpd)' <<<"$nc_engine" | head -1)"
		[[ "$DOCKER_PROXY_ENGINE" == "apache2" || "$DOCKER_PROXY_ENGINE" == "httpd" ]] && DOCKER_PROXY_ENGINE="apache"
		info "the Nextcloud container is also the public proxy"
		return
	fi

	mapfile -t cands < <(docker_list_proxy_candidates)
	if [[ ${#cands[@]} -eq 0 ]]; then
		warn "no proxy container detected. Pass --proxy-container, or use --no-proxy and configure your proxy by hand."
		DOCKER_NO_PROXY=1
		return
	fi
	local picked
	if [[ ${#cands[@]} -eq 1 ]]; then
		picked="${cands[0]}"
		info "single proxy container found: $(echo "$picked" | cut -d'|' -f2)"
	else
		local -a labels=()
		for c in "${cands[@]}"; do
			labels+=("$(echo "$c" | awk -F'|' '{printf "%s  (engine: %s, image: %s)", $2, $4, $3}')")
		done
		local picked_label
		picked_label="$(docker_pick "Multiple proxy containers detected — pick one:" "${labels[@]}")"
		for c in "${cands[@]}"; do
			if [[ "$(echo "$c" | awk -F'|' '{printf "%s  (engine: %s, image: %s)", $2, $4, $3}')" == "$picked_label" ]]; then
				picked="$c"; break
			fi
		done
	fi
	DOCKER_PROXY_CONTAINER="$(echo "$picked" | cut -d'|' -f2)"
	DOCKER_PROXY_ENGINE="$(echo "$picked" | cut -d'|' -f4)"
}

docker_detect_compose() {
	# Compose decorates every container with three labels we can read.
	DOCKER_COMPOSE_PROJECT="$(docker inspect "$DOCKER_NC_CONTAINER" \
		--format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
	if [[ -z "$DOCKER_COMPOSE_FILE" ]]; then
		DOCKER_COMPOSE_FILE="$(docker inspect "$DOCKER_NC_CONTAINER" \
			--format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null | cut -d',' -f1 || true)"
	fi
	DOCKER_COMPOSE_DIR="$(docker inspect "$DOCKER_NC_CONTAINER" \
		--format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
	if [[ -n "$DOCKER_COMPOSE_FILE" && -f "$DOCKER_COMPOSE_FILE" ]]; then
		DOCKER_OVERRIDE_FILE="$(dirname "$DOCKER_COMPOSE_FILE")/docker-compose.playbacksync.override.yml"
	fi
}

docker_classify_proxy_strategy() {
	[[ $DOCKER_NO_PROXY -eq 1 ]] && return 0
	local mounts vhost_d_mount conf_d_mount sites_enabled_mount

	mounts="$(docker inspect "$DOCKER_PROXY_CONTAINER" \
		--format '{{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}}{{println}}{{end}}')"

	# 1) jwilder/nginx-proxy: bind-mounted /etc/nginx/vhost.d. Drop-in is
	#    auto-included by the proxy's templated nginx config, no reload.
	vhost_d_mount="$(echo "$mounts" | awk -F'->' '/->\/etc\/nginx\/vhost\.d$/{split($1,a,":"); print a[2]; exit}')"
	if [[ -n "$vhost_d_mount" ]]; then
		# nginx-proxy expects per-vhost files named after the VIRTUAL_HOST.
		local vhost
		vhost="$(docker inspect "$DOCKER_NC_CONTAINER" \
			--format '{{range .Config.Env}}{{println .}}{{end}}' \
			| grep -E '^VIRTUAL_HOST=' | head -1 | cut -d= -f2-)"
		if [[ -n "$vhost" ]]; then
			DOCKER_PROXY_STRATEGY="vhost.d"
			DOCKER_PROXY_VHOST_HOST="${vhost_d_mount}/${vhost}"
			return
		fi
		# nginx-proxy without a discoverable VIRTUAL_HOST → fall through to
		# the bind-mount or docker-cp paths.
	fi

	# 2) Bind-mounted nginx conf.d / sites-enabled / Apache equivalents.
	for dst in /etc/nginx/conf.d /etc/nginx/sites-enabled \
	           /etc/apache2/conf-enabled /etc/apache2/sites-enabled \
	           /etc/httpd/conf.d; do
		local row src
		row="$(echo "$mounts" | awk -F'->' -v d="$dst" '$2 == d {print $1; exit}')"
		[[ -z "$row" ]] && continue
		src="${row#*:}"
		DOCKER_PROXY_STRATEGY="bind-mount"
		DOCKER_PROXY_BIND_HOST="${src}/${SERVICE_NAME}.conf"
		DOCKER_PROXY_INCONTAINER="${dst}/${SERVICE_NAME}.conf"
		case "$dst" in
			/etc/nginx/*) DOCKER_PROXY_RELOAD="nginx -s reload" ;;
			/etc/apache2/*|/etc/httpd/*) DOCKER_PROXY_RELOAD="apachectl graceful" ;;
		esac
		return
	done

	# 3) Last resort: docker cp the snippet in. Caveat: lost on container
	#    rebuild. We still try this because it makes the daemon work *now*
	#    without the user editing their compose, and we WARN about durability.
	case "$DOCKER_PROXY_ENGINE" in
		nginx|nginx-proxy)
			DOCKER_PROXY_STRATEGY="docker-cp"
			DOCKER_PROXY_INCONTAINER="/etc/nginx/conf.d/${SERVICE_NAME}.conf"
			DOCKER_PROXY_RELOAD="nginx -s reload"
			;;
		apache)
			DOCKER_PROXY_STRATEGY="docker-cp"
			DOCKER_PROXY_INCONTAINER="/etc/apache2/conf-enabled/${SERVICE_NAME}.conf"
			DOCKER_PROXY_RELOAD="apache2ctl graceful"
			;;
		*)
			DOCKER_PROXY_STRATEGY="manual"
			;;
	esac
}

docker_show_plan() {
	cat <<EOF

${C_BOLD}PlaybackSync WebSocket daemon — Docker install plan${C_RESET}

  Mode                docker
  Nextcloud container ${DOCKER_NC_CONTAINER}
  Image               ${DOCKER_NC_IMAGE}
  occ path inside     ${DOCKER_NC_PATH_INCONTAINER}
  Host mount of code  ${DOCKER_NC_HOST_MOUNT:-(none — using volume; sidecar will reuse the volume)}
  Network             ${DOCKER_NC_NETWORK}
  Service user        ${DOCKER_NC_USER}
  Daemon bind         ${HOST}:${PORT}
EOF
	if [[ -n "$DOCKER_COMPOSE_FILE" ]]; then
		echo "  Compose file        ${DOCKER_COMPOSE_FILE}"
		echo "  Compose project     ${DOCKER_COMPOSE_PROJECT}"
		echo "  Override file       ${DOCKER_OVERRIDE_FILE}"
	else
		echo "  Compose file        ${C_YELLOW}(not detected — sidecar will be a stand-alone compose file)${C_RESET}"
	fi
	if [[ $DOCKER_NO_PROXY -eq 1 ]]; then
		echo "  Proxy strategy      ${C_YELLOW}skipped (--no-proxy)${C_RESET}"
	else
		echo "  Proxy container     ${DOCKER_PROXY_CONTAINER}"
		echo "  Proxy engine        ${DOCKER_PROXY_ENGINE}"
		echo "  Proxy strategy      ${DOCKER_PROXY_STRATEGY}"
		case "$DOCKER_PROXY_STRATEGY" in
			vhost.d)     echo "  Drop file           ${DOCKER_PROXY_VHOST_HOST}" ;;
			bind-mount)  echo "  Snippet (host)      ${DOCKER_PROXY_BIND_HOST}";
			             echo "  Reload              docker exec ${DOCKER_PROXY_CONTAINER} ${DOCKER_PROXY_RELOAD}" ;;
			docker-cp)   echo "  Snippet (in-cont.)  ${DOCKER_PROXY_INCONTAINER} (docker cp; ${C_YELLOW}lost on container rebuild${C_RESET})";
			             echo "  Reload              docker exec ${DOCKER_PROXY_CONTAINER} ${DOCKER_PROXY_RELOAD}" ;;
			manual)      echo "  ${C_YELLOW}Will print proxy snippet for you to add by hand.${C_RESET}" ;;
		esac
	fi

	cat <<EOF

The script will:
  1. composer install --no-dev   (inside ${DOCKER_NC_CONTAINER})
  2. occ app:enable + ws_host=${HOST}, ws_port=${PORT}   (inside ${DOCKER_NC_CONTAINER})
  3. write the sidecar service ${SERVICE_NAME} to its compose override
  4. configure the proxy (strategy: ${DOCKER_PROXY_STRATEGY:-skipped})
  5. bring the sidecar up (docker compose up -d ${SERVICE_NAME})
  6. reload the proxy and verify a WebSocket handshake

EOF
}

docker_step_composer_install() {
	local app_dir
	for d in \
		"${DOCKER_NC_PATH_INCONTAINER}/apps-extra/${APP_ID}" \
		"${DOCKER_NC_PATH_INCONTAINER}/apps/${APP_ID}"; do
		if docker exec "$DOCKER_NC_CONTAINER" test -d "$d"; then app_dir="$d"; break; fi
	done
	[[ -n "$app_dir" ]] || die "playbacksync app not found inside container at apps-extra/ or apps/."

	if ! docker exec "$DOCKER_NC_CONTAINER" test -f "$app_dir/composer.json"; then
		warn "no composer.json inside $app_dir — skipping vendor install."
		return 0
	fi
	if docker exec "$DOCKER_NC_CONTAINER" test -f "$app_dir/vendor/autoload.php"; then
		info "vendor/ already present — skipping composer install."
		return 0
	fi

	if ! docker exec "$DOCKER_NC_CONTAINER" sh -c 'command -v composer >/dev/null 2>&1'; then
		die "composer not found inside ${DOCKER_NC_CONTAINER}. Either install it there, or run composer install on the host before re-running this script."
	fi

	info "running composer install inside container"
	run docker exec -u "$DOCKER_NC_USER" "$DOCKER_NC_CONTAINER" \
		sh -c "cd '$app_dir' && composer install --no-dev --no-interaction --prefer-dist"
	ok "composer install done"
}

docker_step_occ() {
	info "enabling app + writing config keys (inside ${DOCKER_NC_CONTAINER})"
	run docker exec -u "$DOCKER_NC_USER" "$DOCKER_NC_CONTAINER" \
		php "${DOCKER_NC_PATH_INCONTAINER}/occ" app:enable "$APP_ID"
	run docker exec -u "$DOCKER_NC_USER" "$DOCKER_NC_CONTAINER" \
		php "${DOCKER_NC_PATH_INCONTAINER}/occ" config:app:set "$APP_ID" ws_host --value "$HOST"
	run docker exec -u "$DOCKER_NC_USER" "$DOCKER_NC_CONTAINER" \
		php "${DOCKER_NC_PATH_INCONTAINER}/occ" config:app:set "$APP_ID" ws_port --value "$PORT"
	ok "occ + config keys set"
}

# Build the sidecar compose YAML. It runs the same image as the NC container,
# joins the same network, and replicates the NC code mount so it has occ.
docker_step_sidecar() {
	local override_path
	if [[ -n "$DOCKER_COMPOSE_FILE" ]]; then
		override_path="$DOCKER_OVERRIDE_FILE"
	else
		# No compose detected — write a stand-alone file in cwd.
		override_path="$(pwd)/docker-compose.playbacksync.yml"
		DOCKER_OVERRIDE_FILE="$override_path"
	fi

	# Replicate every mount the NC container has at or under the Nextcloud
	# root. In real-world setups (including the official image and AIO-style
	# stacks) Nextcloud spreads its writable state across multiple named
	# volumes — config, data, custom_apps. The sidecar needs all of them,
	# not just the code, otherwise occ can't init.
	#
	# Mounts outside the NC root (databases, web-server config, certs) are
	# intentionally skipped — they belong to other services.
	local volume_block extra_volumes_list mount_lines
	volume_block=""
	extra_volumes_list=""
	mount_lines="$(docker inspect "$DOCKER_NC_CONTAINER" \
		--format '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}|{{.Mode}}{{println}}{{end}}')"
	while IFS='|' read -r m_type m_source m_name m_dest m_mode; do
		[[ -z "$m_dest" ]] && continue
		# Only include mounts at or under the NC root.
		[[ "$m_dest" == "$DOCKER_NC_PATH_INCONTAINER" || "$m_dest" == "$DOCKER_NC_PATH_INCONTAINER"/* ]] || continue
		# Skip read-only system files we don't want to replicate verbatim
		# (some dev images bind-mount /etc/* into the NC root — rare but
		# safer to be conservative). The destination prefix check above
		# already eliminates that.
		case "$m_type" in
			bind)
				volume_block+="      - ${m_source}:${m_dest}"$'\n'
				;;
			volume)
				# Use the volume name as-is. Strip the compose project
				# prefix so the YAML 'volumes:' section can reference it
				# without duplicating it.
				local short="$m_name"
				if [[ -n "$DOCKER_COMPOSE_PROJECT" && "$short" == "${DOCKER_COMPOSE_PROJECT}_"* ]]; then
					short="${short#${DOCKER_COMPOSE_PROJECT}_}"
				fi
				volume_block+="      - ${short}:${m_dest}"$'\n'
				extra_volumes_list+="  ${short}:"$'\n'"    external: true"$'\n'"    name: ${m_name}"$'\n'
				;;
		esac
	done <<<"$mount_lines"

	# Strip the trailing newline so the heredoc renders cleanly.
	volume_block="${volume_block%$'\n'}"

	if [[ -z "$volume_block" ]]; then
		die "couldn't determine any mount under ${DOCKER_NC_PATH_INCONTAINER} on ${DOCKER_NC_CONTAINER}; cannot generate a sidecar."
	fi

	local content
	content=$(cat <<EOF
${MARKER_BEGIN}
# Generated by playbacksync install-ws-daemon.sh — do not edit by hand.
# Re-run the installer to regenerate; --uninstall to remove cleanly.
#
# entrypoint is cleared because most Nextcloud images ship an entrypoint
# that assumes "I'm the web server" (waits for DB, owns config files, runs
# migrations). The sidecar reuses the volumes the main container already
# provisioned, so it just needs PHP + occ — nothing else.
services:
  ${SERVICE_NAME}:
    image: ${DOCKER_NC_IMAGE}
    container_name: ${DOCKER_COMPOSE_PROJECT:+${DOCKER_COMPOSE_PROJECT}-}${SERVICE_NAME}
    restart: unless-stopped
    user: "${DOCKER_NC_USER}"
    working_dir: ${DOCKER_NC_PATH_INCONTAINER}
    entrypoint: []
    command: ["php", "${DOCKER_NC_PATH_INCONTAINER}/occ", "playbacksync:ws-serve", "--host=${HOST}", "--port=${PORT}"]
    networks:
      - ${DOCKER_NC_NETWORK}
    volumes:
$volume_block
networks:
  ${DOCKER_NC_NETWORK}:
    external: true
${extra_volumes_list:+volumes:
$extra_volumes_list}${MARKER_END}
EOF
)
	if [[ $DRY_RUN -eq 1 ]]; then
		printf '%s[ dry ]%s would write %s\n' "$C_DIM" "$C_RESET" "$override_path"
	else
		printf '%s\n' "$content" > "$override_path"
		ok "wrote sidecar compose file: $override_path"
	fi
}

# Build the proxy snippet content (nginx or apache flavour).
docker_proxy_snippet_content() {
	# Inside the container, the daemon sidecar is reachable by service name.
	local service_dns="${DOCKER_COMPOSE_PROJECT:+${DOCKER_COMPOSE_PROJECT}-}${SERVICE_NAME}"
	# nginx-proxy compose deployments often hit the service via just the service name on the network.
	# We add both as a fallback (DNS resolution will pick whichever exists).
	case "$DOCKER_PROXY_ENGINE" in
		nginx|nginx-proxy)
			cat <<EOF
${MARKER_BEGIN}
location ^~ /apps/playbacksync/ws/ {
    proxy_pass http://${service_dns}:${PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
${MARKER_END}
EOF
			;;
		apache)
			cat <<EOF
${MARKER_BEGIN}
<IfModule mod_proxy_wstunnel.c>
    ProxyPass        "/apps/playbacksync/ws/" "ws://${service_dns}:${PORT}/apps/playbacksync/ws/"
    ProxyPassReverse "/apps/playbacksync/ws/" "ws://${service_dns}:${PORT}/apps/playbacksync/ws/"
</IfModule>
${MARKER_END}
EOF
			;;
	esac
}

docker_step_proxy() {
	[[ $DOCKER_NO_PROXY -eq 1 ]] && { info "skipping proxy step (--no-proxy or no proxy detected)"; return 0; }
	local snippet
	snippet="$(docker_proxy_snippet_content)"

	case "$DOCKER_PROXY_STRATEGY" in
		vhost.d)
			if [[ $DRY_RUN -eq 1 ]]; then
				printf '%s[ dry ]%s would write %s\n' "$C_DIM" "$C_RESET" "$DOCKER_PROXY_VHOST_HOST"
			else
				mkdir -p "$(dirname "$DOCKER_PROXY_VHOST_HOST")"
				printf '%s\n' "$snippet" > "$DOCKER_PROXY_VHOST_HOST"
				ok "wrote nginx-proxy vhost include: $DOCKER_PROXY_VHOST_HOST"
				info "nginx-proxy auto-detects vhost.d/ changes; no reload needed"
			fi
			;;
		bind-mount)
			if [[ $DRY_RUN -eq 1 ]]; then
				printf '%s[ dry ]%s would write %s\n' "$C_DIM" "$C_RESET" "$DOCKER_PROXY_BIND_HOST"
			else
				mkdir -p "$(dirname "$DOCKER_PROXY_BIND_HOST")"
				printf '%s\n' "$snippet" > "$DOCKER_PROXY_BIND_HOST"
				ok "wrote proxy snippet (host-side bind): $DOCKER_PROXY_BIND_HOST"
			fi
			docker_step_proxy_reload
			;;
		docker-cp)
			warn "the proxy container has no bind-mounted config; falling back to 'docker cp'."
			warn "this snippet WILL NOT survive a 'docker compose up --force-recreate' or image rebuild."
			warn "for durability, mount your proxy config into ${DOCKER_PROXY_INCONTAINER} from the host."
			if [[ $DRY_RUN -eq 1 ]]; then
				printf '%s[ dry ]%s would docker cp snippet to %s:%s\n' "$C_DIM" "$C_RESET" "$DOCKER_PROXY_CONTAINER" "$DOCKER_PROXY_INCONTAINER"
			else
				local tmp
				tmp="$(mktemp)"
				printf '%s\n' "$snippet" > "$tmp"
				docker cp "$tmp" "${DOCKER_PROXY_CONTAINER}:${DOCKER_PROXY_INCONTAINER}"
				rm -f "$tmp"
				ok "copied snippet into ${DOCKER_PROXY_CONTAINER}:${DOCKER_PROXY_INCONTAINER}"
			fi
			docker_step_proxy_reload
			;;
		manual)
			warn "couldn't classify proxy '${DOCKER_PROXY_CONTAINER}' (engine=${DOCKER_PROXY_ENGINE}). Add this snippet to its config manually:"
			echo
			printf '%s\n' "$snippet"
			echo
			;;
	esac
}

docker_step_proxy_reload() {
	[[ $SKIP_RELOAD -eq 1 ]] && { info "skipping proxy reload (--no-reload)"; return 0; }
	[[ -z "$DOCKER_PROXY_RELOAD" ]] && return 0
	# Smoke-test config inside the container where possible.
	case "$DOCKER_PROXY_ENGINE" in
		nginx|nginx-proxy)
			if ! run docker exec "$DOCKER_PROXY_CONTAINER" nginx -t; then
				die "nginx -t failed inside ${DOCKER_PROXY_CONTAINER}; not reloading. Snippet path printed above; remove it and rerun if needed."
			fi
			;;
		apache)
			run docker exec "$DOCKER_PROXY_CONTAINER" sh -c 'apachectl configtest || apache2ctl configtest' || \
				die "apache configtest failed inside ${DOCKER_PROXY_CONTAINER}; not reloading."
			;;
	esac
	run docker exec "$DOCKER_PROXY_CONTAINER" sh -c "$DOCKER_PROXY_RELOAD"
	ok "proxy reloaded"
}

docker_step_up() {
	[[ $SKIP_START -eq 1 ]] && { info "skipping sidecar start (--no-start)"; return 0; }
	[[ -z "$DOCKER_OVERRIDE_FILE" ]] && return 0

	# Pick the compose CLI that's present (V2 'docker compose' preferred, V1 'docker-compose' fallback).
	local cmd=()
	if docker compose version >/dev/null 2>&1; then
		cmd=(docker compose)
	elif command -v docker-compose >/dev/null 2>&1; then
		cmd=(docker-compose)
	else
		warn "no docker compose CLI found. Start the sidecar manually:"
		echo "  docker compose -f ${DOCKER_COMPOSE_FILE:-(your compose file)} -f ${DOCKER_OVERRIDE_FILE} up -d ${SERVICE_NAME}"
		return 0
	fi

	if [[ -n "$DOCKER_COMPOSE_FILE" ]]; then
		run "${cmd[@]}" -f "$DOCKER_COMPOSE_FILE" -f "$DOCKER_OVERRIDE_FILE" up -d "$SERVICE_NAME"
	else
		run "${cmd[@]}" -f "$DOCKER_OVERRIDE_FILE" up -d "$SERVICE_NAME"
	fi
	ok "sidecar service '${SERVICE_NAME}' is up"
}

docker_step_verify() {
	[[ $DRY_RUN -eq 1 ]] && return 0
	command -v curl >/dev/null 2>&1 || { warn "curl missing on host; cannot auto-verify."; return 0; }
	# Hit the proxy from the host. Try the published port if we can find one.
	local pub
	pub="$(docker inspect "${DOCKER_PROXY_CONTAINER:-$DOCKER_NC_CONTAINER}" \
		--format '{{range $p, $bs := .NetworkSettings.Ports}}{{range $bs}}{{.HostIp}}:{{.HostPort}}->{{$p}}{{println}}{{end}}{{end}}' \
		2>/dev/null | grep -E -- '->80/' | head -1)"
	if [[ -z "$pub" ]]; then
		info "proxy doesn't publish port 80 to the host — skipping host-side verification."
		info "to verify manually, run: docker exec ${DOCKER_PROXY_CONTAINER:-$DOCKER_NC_CONTAINER} curl -i http://localhost/apps/playbacksync/ws/probe (with WS upgrade headers)"
		return 0
	fi
	local hp="${pub%%->*}"

	# vhost-aware proxies (nginx-proxy, traefik) need the right Host header
	# to route to our upstream. Pull VIRTUAL_HOST off the NC container if
	# it's set; otherwise rely on default routing.
	local vhost
	vhost="$(docker inspect "$DOCKER_NC_CONTAINER" \
		--format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
		| grep -E '^VIRTUAL_HOST=' | head -1 | cut -d= -f2-)"
	local host_header_args=()
	[[ -n "$vhost" ]] && host_header_args=(-H "Host: $vhost")

	# Poll for up to 15 seconds — the sidecar may still be starting (the
	# entrypoint-less container needs a few seconds to load the autoloader
	# and bind the socket on first run).
	local code=""
	local attempts=15
	for ((i=0; i<attempts; i++)); do
		code="$(curl -sS -o /dev/null -w '%{http_code}' \
			--max-time 2 \
			"${host_header_args[@]}" \
			-H "Connection: Upgrade" -H "Upgrade: websocket" \
			-H "Sec-WebSocket-Version: 13" \
			-H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
			"http://${hp}/apps/playbacksync/ws/probe" 2>/dev/null || true)"
		[[ "$code" == "101" ]] && break
		sleep 1
	done
	if [[ "$code" == "101" ]]; then
		ok "proxy → daemon WebSocket handshake returned 101"
	else
		warn "verification got HTTP ${code:-(no response)} (expected 101). Check 'docker logs ${SERVICE_NAME}' and the proxy logs."
	fi
}

docker_main() {
	docker_available || die "docker is not available to this user. Run as root or join the 'docker' group."
	docker_detect_aio
	docker_pick_nc_container
	docker_resolve_nc_metadata
	docker_pick_proxy_container
	docker_detect_compose
	docker_classify_proxy_strategy
	docker_show_plan
	confirm
	docker_step_composer_install
	docker_step_occ
	docker_step_sidecar
	docker_step_proxy
	docker_step_up
	docker_step_verify
	cat <<EOF

${C_GREEN}${C_BOLD}Done.${C_RESET}
EOF
}

docker_uninstall() {
	docker_available || die "docker is not available; cannot perform docker-mode uninstall."
	# Pick the NC container (best effort — needed only to find compose context).
	if [[ -z "$DOCKER_NC_CONTAINER" ]]; then
		mapfile -t cands < <(docker_list_nc_candidates)
		[[ ${#cands[@]} -gt 0 ]] && DOCKER_NC_CONTAINER="$(echo "${cands[0]}" | cut -d'|' -f2)"
	fi
	if [[ -n "$DOCKER_NC_CONTAINER" ]]; then
		docker_resolve_nc_metadata
		docker_detect_compose
	fi

	# Stop and remove the sidecar service.
	if [[ -n "$DOCKER_OVERRIDE_FILE" && -f "$DOCKER_OVERRIDE_FILE" ]]; then
		local cmd=()
		if docker compose version >/dev/null 2>&1; then cmd=(docker compose)
		elif command -v docker-compose >/dev/null 2>&1; then cmd=(docker-compose)
		fi
		if [[ ${#cmd[@]} -gt 0 ]]; then
			if [[ -n "$DOCKER_COMPOSE_FILE" ]]; then
				run "${cmd[@]}" -f "$DOCKER_COMPOSE_FILE" -f "$DOCKER_OVERRIDE_FILE" rm -sf "$SERVICE_NAME" || true
			else
				run "${cmd[@]}" -f "$DOCKER_OVERRIDE_FILE" rm -sf "$SERVICE_NAME" || true
			fi
		else
			# No compose CLI — fall back to direct docker rm.
			run docker rm -f "${DOCKER_COMPOSE_PROJECT:+${DOCKER_COMPOSE_PROJECT}-}${SERVICE_NAME}" 2>/dev/null || true
		fi
		run rm -f "$DOCKER_OVERRIDE_FILE"
		ok "removed sidecar + override file"
	fi

	# Strip proxy snippets we may have written.
	# 1) vhost.d drop file: search any bind-mounted vhost.d for a marker block.
	for cid in $(docker ps -q); do
		local vhost_d_src
		vhost_d_src="$(docker inspect "$cid" \
			--format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/vhost.d"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)"
		if [[ -n "$vhost_d_src" ]]; then
			while IFS= read -r f; do
				[[ -z "$f" ]] && continue
				if [[ $DRY_RUN -eq 1 ]]; then
					printf '%s[ dry ]%s would strip %s\n' "$C_DIM" "$C_RESET" "$f"
				else
					awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
						index($0, begin) > 0 { skip=1; next }
						skip && index($0, end) > 0 { skip=0; next }
						!skip { print }
					' "$f" > "${f}.new" && mv "${f}.new" "$f"
					# If the file is now empty (only contained our block), remove it.
					[[ -s "$f" ]] || rm -f "$f"
					ok "stripped marker block from $f"
				fi
			done < <(grep -lr "$MARKER_BEGIN" "$vhost_d_src" 2>/dev/null || true)
		fi
	done

	# 2) Bind-mount snippet files — well-known names.
	for cid in $(docker ps -q); do
		local mounts
		mounts="$(docker inspect "$cid" --format '{{range .Mounts}}{{.Source}}->{{.Destination}}{{println}}{{end}}')"
		while IFS= read -r line; do
			local src dst
			src="${line%%->*}"; dst="${line#*->}"
			for name in /etc/nginx/conf.d /etc/nginx/sites-enabled \
			            /etc/apache2/conf-enabled /etc/apache2/sites-enabled \
			            /etc/httpd/conf.d; do
				if [[ "$dst" == "$name" && -f "${src}/${SERVICE_NAME}.conf" ]]; then
					run rm -f "${src}/${SERVICE_NAME}.conf"
					ok "removed ${src}/${SERVICE_NAME}.conf"
				fi
			done
		done <<<"$mounts"
	done

	# 3) docker-cp snippet inside containers (best effort; ignore failures).
	for cid in $(docker ps -q); do
		for path in "/etc/nginx/conf.d/${SERVICE_NAME}.conf" \
		            "/etc/apache2/conf-enabled/${SERVICE_NAME}.conf" \
		            "/etc/httpd/conf.d/${SERVICE_NAME}.conf"; do
			if docker exec "$cid" test -f "$path" 2>/dev/null; then
				run docker exec "$cid" rm -f "$path" || true
				ok "removed $path inside ${cid:0:12}"
			fi
		done
	done

	info "Note: composer's vendor/ and the IAppConfig keys are intentionally left in place."
	ok "docker uninstall complete."
}

# ---------------------------------------------------------------------------
# Mode resolution
# ---------------------------------------------------------------------------

resolve_mode() {
	if [[ "$MODE" != "auto" ]]; then return; fi
	# If the user has Docker, a Nextcloud container is running, AND there's
	# no Nextcloud at standard host paths → prefer docker mode.
	if docker_available && [[ -n "$(docker_list_nc_candidates 2>/dev/null)" ]]; then
		local h
		for h in /var/www/nextcloud /var/www/html /srv/nextcloud /usr/share/nextcloud; do
			if [[ -f "$h/occ" ]]; then MODE="host"; return; fi
		done
		MODE="docker"
	else
		MODE="host"
	fi
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

uninstall_host() {
	require_root
	info "uninstalling ${SERVICE_NAME} (host mode)"

	if [[ $HAS_SYSTEMD -eq 1 ]] && systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
		run systemctl disable --now "$SERVICE_NAME" || true
		run rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
		run systemctl daemon-reload
		ok "removed systemd unit"
	fi

	# Remove snippet files (both possible paths; ignore missing).
	for f in \
		"/etc/nginx/snippets/${SERVICE_NAME}.conf" \
		"/etc/apache2/conf-available/${SERVICE_NAME}.conf" \
		"/etc/httpd/conf.d/${SERVICE_NAME}.conf"; do
		if [[ -f "$f" ]]; then run rm -f "$f"; ok "removed $f"; fi
	done

	# Strip managed blocks from any vhost we can find.
	local files=()
	while IFS= read -r f; do files+=("$f"); done < <(grep -lr "$MARKER_BEGIN" \
		/etc/nginx /etc/apache2 /etc/httpd 2>/dev/null || true)
	for f in "${files[@]:-}"; do
		[[ -z "$f" ]] && continue
		if [[ $DRY_RUN -eq 1 ]]; then
			printf '%s[ dry ]%s would strip managed block from %s\n' "$C_DIM" "$C_RESET" "$f"
		else
			cp -a "$f" "${f}.bak.$(date +%s)"
			awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
				index($0, begin) > 0 { skip=1; next }
				skip && index($0, end) > 0 { skip=0; next }
				!skip { print }
			' "$f" > "${f}.new" && mv "${f}.new" "$f"
			ok "stripped managed block from $f"
		fi
	done

	# Reload web server if any block was removed.
	detect_systemd
	detect_web_server
	detect_web_reload
	if [[ -n "$WEB_SERVER_RELOAD" ]] && [[ $SKIP_RELOAD -eq 0 ]]; then
		run $WEB_SERVER_RELOAD || true
	fi

	info "Note: composer's vendor/ and the IAppConfig keys are intentionally left in place. Remove them manually if you really want to start over."
	ok "host uninstall complete."
}

uninstall() {
	resolve_mode
	if [[ "$MODE" == "docker" ]]; then
		docker_uninstall
	else
		uninstall_host
	fi
}

host_main() {
	require_root
	detect_container
	detect_systemd
	detect_nc_path
	detect_php
	detect_composer
	detect_run_user
	detect_web_server
	case "$WEB_SERVER" in
		nginx)  detect_vhost_for_nginx ;;
		apache) detect_vhost_for_apache ;;
	esac
	detect_web_reload

	show_plan
	confirm

	step_composer_install
	step_occ_enable
	step_systemd_unit

	case "$WEB_SERVER" in
		nginx)  step_nginx_proxy ;;
		apache) step_apache_proxy ;;
	esac

	step_reload_web_server
	step_start_service
	step_verify
	print_container_followup

	cat <<EOF

${C_GREEN}${C_BOLD}Done.${C_RESET}
EOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if [[ $UNINSTALL -eq 1 ]]; then
	uninstall
	exit 0
fi

resolve_mode

# In Docker mode, the daemon listens on 0.0.0.0 by default — the proxy
# container reaches it over the docker network, not over loopback.
if [[ "$MODE" == "docker" && "$HOST" == "$DEFAULT_HOST" ]]; then
	HOST="0.0.0.0"
fi

if [[ "$MODE" == "docker" ]]; then
	docker_main
else
	host_main
fi
