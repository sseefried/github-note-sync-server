#!/usr/bin/env bash
set -euo pipefail

prompt() {
  local label="$1"
  local default_value="$2"
  local value

  read -r -p "${label} [${default_value}]: " value
  if [[ -z "${value}" ]]; then
    value="${default_value}"
  fi

  printf '%s' "${value}"
}

PUBLIC_PROXY_IP="$(prompt 'External reverse-proxy IP' '203.0.113.10')"
INTERNAL_APP_IP="$(prompt 'Internal app-server IP' '192.168.1.10')"
APP_USER="$(prompt 'App user on the internal server' "${USER:-app}")"
CLIENT_PORT="$(prompt 'Internal client service port' '4173')"
SERVER_PORT="$(prompt 'Internal server service port' '3001')"
PUBLIC_NAME="$(prompt 'Public hostname served by nginx' 'notes.example.com')"
INTERNAL_FIREWALL_TOOL="$(prompt 'Internal firewall tool (ufw/none)' 'ufw')"
EXTERNAL_FIREWALL_TOOL="$(prompt 'External firewall tool (ufw/none)' 'ufw')"

PUBLIC_BASE_URL="https://${PUBLIC_NAME}"

cat <<EOF
GitHub Note Sync deployment instructions
========================================

Summary
-------
- External reverse-proxy host: ${PUBLIC_PROXY_IP}
- Internal app host: ${INTERNAL_APP_IP}
- Public name served by nginx: ${PUBLIC_NAME}
- App user on internal host: ${APP_USER}
- Internal client port: ${CLIENT_PORT}
- Internal server API port: ${SERVER_PORT}
- Public HTTPS base URL for the client service: ${PUBLIC_BASE_URL}

Run these commands as root on the internal app host (${INTERNAL_APP_IP})
-----------------------------------------------------------------------
1. Enable lingering for the app user so the user services survive full server reboots:

   sudo loginctl enable-linger ${APP_USER}

2. Open the internal firewall so only the reverse proxy can reach the client and server ports:
EOF

if [[ "${INTERNAL_FIREWALL_TOOL}" == "ufw" ]]; then
  cat <<EOF

   sudo ufw allow from ${PUBLIC_PROXY_IP} to any port ${CLIENT_PORT} proto tcp
   sudo ufw allow from ${PUBLIC_PROXY_IP} to any port ${SERVER_PORT} proto tcp

EOF
else
  cat <<EOF

   Allow ${PUBLIC_PROXY_IP} -> ${INTERNAL_APP_IP}:${CLIENT_PORT}/tcp
   Allow ${PUBLIC_PROXY_IP} -> ${INTERNAL_APP_IP}:${SERVER_PORT}/tcp

EOF
fi

cat <<EOF
3. Verify the app-user services are listening after you run the app-user installers:

   sudo -u ${APP_USER} XDG_RUNTIME_DIR=/run/user/\$(id -u ${APP_USER}) systemctl --user status github-note-sync-client.service
   sudo -u ${APP_USER} XDG_RUNTIME_DIR=/run/user/\$(id -u ${APP_USER}) systemctl --user status github-note-sync-server.service
   ss -ltnp | grep -E ':(${CLIENT_PORT}|${SERVER_PORT})\\b'

4. The client user-service installer should be pointed at the public URL:

   --server-url=${PUBLIC_BASE_URL}

5. The server user-service installer should allow the public browser origin explicitly:

   --allowed-origin=${PUBLIC_BASE_URL}

Run these commands as root on the external reverse-proxy host (${PUBLIC_PROXY_IP})
---------------------------------------------------------------------------------
1. Install and enable nginx if it is not already present.
   Install certificates for ${PUBLIC_NAME} before you enable the HTTPS server block below.

2. Open the public firewall for HTTP and HTTPS:
EOF

if [[ "${EXTERNAL_FIREWALL_TOOL}" == "ufw" ]]; then
  cat <<EOF

   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp

EOF
else
  cat <<EOF

   Allow inbound 80/tcp
   Allow inbound 443/tcp

EOF
fi

cat <<EOF
3. Create /etc/nginx/sites-available/github-note-sync with this content:

server {
    listen 80;
    server_name ${PUBLIC_NAME};

    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${PUBLIC_NAME};

    ssl_certificate /etc/letsencrypt/live/${PUBLIC_NAME}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${PUBLIC_NAME}/privkey.pem;

    location /api/ {
        proxy_pass http://${INTERNAL_APP_IP}:${SERVER_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location / {
        proxy_pass http://${INTERNAL_APP_IP}:${CLIENT_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}

4. Enable the site and reload nginx:

   sudo ln -sf /etc/nginx/sites-available/github-note-sync /etc/nginx/sites-enabled/github-note-sync
   sudo nginx -t
   sudo systemctl reload nginx

5. Obtain and install certificates before reloading nginx.
   - For a public deployment, use certbot or your preferred ACME flow for ${PUBLIC_NAME}.
   - If you do not have a DNS name for ${PUBLIC_NAME}, stop here and create one first. This deployment now assumes HTTPS-only browser access.

Verification
------------
From the external reverse-proxy host:

   curl -I http://${INTERNAL_APP_IP}:${CLIENT_PORT}
   curl -I -H 'X-Forwarded-Proto: https' http://${INTERNAL_APP_IP}:${SERVER_PORT}/api/repos

From anywhere that can reach the external host:

   curl -I http://${PUBLIC_NAME}
   curl -I ${PUBLIC_BASE_URL}/api/repos

Notes
-----
- This script does not make root-owned changes. It only prints the required commands and nginx config.
- The client and server both assume browser traffic arrives through HTTPS at the reverse proxy.
- Re-run the app-user installers after code changes. Re-run the nginx steps only if the IPs, ports, or hostname change.
EOF
