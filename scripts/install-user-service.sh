#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="github-note-sync-server"
INSTALL_DIR="${HOME}/.local/opt/${SERVICE_NAME}"
SYSTEMD_DIR="${HOME}/.config/systemd/user"
UNIT_PATH="${SYSTEMD_DIR}/${SERVICE_NAME}.service"
PORT="3001"
SYNC_INTERVAL_MS="30000"
GIT_USER_NAME="GitHub Note Sync"
GIT_USER_EMAIL="note-sync@example.com"
ALLOWED_ORIGINS=()

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/install-user-service.sh [options]

Options:
  --install-dir PATH         Installation directory for the deployed app
  --port PORT                Listen port written into config.json
  --sync-interval-ms MS      Auto-sync interval in milliseconds
  --git-user-name NAME       Git commit author name used by the server
  --git-user-email EMAIL     Git commit author email used by the server
  --allowed-origin URL       Browser origin allowed by CORS (repeatable)
  --help                     Show this help
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

copy_repo() {
  rm -rf "${INSTALL_DIR}"
  mkdir -p "${INSTALL_DIR}"

  (
    cd "${SOURCE_DIR}"
    tar \
      --exclude='.git' \
      --exclude='node_modules' \
      --exclude='scripts/install-user-service.sh' \
      -cf - .
  ) | (
    cd "${INSTALL_DIR}"
    tar -xf -
  )
}

write_config() {
  local allowed_origins_json='[]'
  local allowed_origin

  if ((${#ALLOWED_ORIGINS[@]} > 0)); then
    allowed_origins_json='['

    for allowed_origin in "${ALLOWED_ORIGINS[@]}"; do
      if [[ "${allowed_origins_json}" != '[' ]]; then
        allowed_origins_json+=', '
      fi

      allowed_origins_json+="\"$(json_escape "${allowed_origin}")\""
    done

    allowed_origins_json+=']'
  fi

  cat > "${INSTALL_DIR}/config.json" <<EOF
{
  "port": ${PORT},
  "syncIntervalMs": ${SYNC_INTERVAL_MS},
  "gitUserName": "$(json_escape "${GIT_USER_NAME}")",
  "gitUserEmail": "$(json_escape "${GIT_USER_EMAIL}")",
  "allowedOrigins": ${allowed_origins_json}
}
EOF
}

write_unit() {
  mkdir -p "${SYSTEMD_DIR}"

  cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=GitHub Note Sync Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/env node server/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
}

while (($# > 0)); do
  case "$1" in
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --sync-interval-ms)
      SYNC_INTERVAL_MS="$2"
      shift 2
      ;;
    --git-user-name)
      GIT_USER_NAME="$2"
      shift 2
      ;;
    --git-user-email)
      GIT_USER_EMAIL="$2"
      shift 2
      ;;
    --allowed-origin)
      ALLOWED_ORIGINS+=("$2")
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

UNIT_PATH="${SYSTEMD_DIR}/${SERVICE_NAME}.service"

require_command node
require_command npm
require_command ssh-keygen
require_command systemctl
require_command tar

copy_repo
write_config

(
  cd "${INSTALL_DIR}"
  npm ci --omit=dev
)

write_unit

systemctl --user daemon-reload
systemctl --user enable "${SERVICE_NAME}.service"
systemctl --user restart "${SERVICE_NAME}.service"

printf 'Installed %s into %s\n' "${SERVICE_NAME}" "${INSTALL_DIR}"
printf 'User unit written to %s\n' "${UNIT_PATH}"
printf 'config.json was overwritten with the requested values.\n'
printf 'Service status: systemctl --user status %s.service\n' "${SERVICE_NAME}"
printf 'Note: full reboot persistence still requires root to run: loginctl enable-linger %s\n' "${USER}"
