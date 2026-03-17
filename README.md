# GitHub Note Sync Server

The server repository is the backend API and git-sync engine. It owns users, password hashes, sessions, per-user repo aliases, local Git clones, and per-alias SSH keypairs. Private SSH keys are generated and stored only on the server machine.

## Installation

1. Install Node.js 25+ and npm.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Run the automated tests:

   ```bash
   npm test
   ```

4. Ensure `ssh-keygen` is installed and available in `PATH`.
5. Optionally copy `config.json.example` to `config.json` and adjust auth, cookie, origin, sync, or commit settings.

## Usage

1. Start the API in development:

   ```bash
   npm run dev
   ```

2. Or start it normally:

   ```bash
   npm start
   ```

3. The API listens on `http://localhost:3001` by default. You can override that with `config.json`, or with `PORT=<port>` which takes precedence over the config file.
4. Register a user from the client or via `POST /api/auth/register` with:
   - `username`: letters, numbers, `_`, and `-` only
   - `password`: at least 8 characters
5. Registration stays open by default so multiple server users can be created. Set `allowRegistration` to `false` in `config.json` if you want to close self-service signup after provisioning accounts.
6. Log in from the client or via `POST /api/auth/login`. The bundled web client requests a bearer `sessionToken`, while generic browser integrations can still rely on a session cookie if they want to.
7. Send `X-Session-Transport: token` to `POST /api/auth/register` or `POST /api/auth/login` to receive a bearer `sessionToken` in the JSON response instead of relying on cookies.
8. Create a repo alias from the client or via `POST /api/repos` with:
   - `repoAlias`: letters, numbers, `_`, and `-` only
   - `repo`: `git@github.com:<username>/<repo>` or `git@github.com:<username>/<repo>.git`
9. Fetch the public key from `GET /api/repos/:repoAlias/public-key` and add it to GitHub so the server can clone and push for that user-owned alias.
10. All server data lives under `$HOME/.local/github-note-sync-server`.
11. Each sync attempt is logged to stdout with an ISO timestamp, the authenticated user id, and the `repoAlias`.

The server now rejects requests that do not arrive with `X-Forwarded-Proto: https`. In practice that means you are expected to run it behind a reverse proxy such as Caddy or nginx in both local HTTPS testing and production. For browser clients on another origin, set `allowedOrigins` in `config.json`.

## Local HTTPS Testing

Use Caddy to terminate TLS locally while keeping the server itself on HTTP. This is required for normal browser use because direct requests to the server port are rejected unless the proxy forwards `X-Forwarded-Proto: https`.

1. Install Caddy on macOS:

   ```bash
   brew install caddy
   ```

2. Create a `Caddyfile` somewhere convenient:

   ```caddy
   notes.localhost {
     reverse_proxy 127.0.0.1:5173
   }

   api.notes.localhost {
     reverse_proxy 127.0.0.1:3001
   }
   ```

3. Configure the server origin allowlist in `config.json`:

   ```json
   {
     "port": 3001,
     "syncIntervalMs": 30000,
     "gitUserName": "GitHub Note Sync",
     "gitUserEmail": "note-sync@example.com",
     "allowedOrigins": [
       "https://notes.localhost"
     ]
   }
   ```

4. Start the server:

   ```bash
   npm run dev
   ```

5. Start the client from the client repository:

   ```bash
   npm run dev -- --server-url=https://api.notes.localhost
   ```

6. Start Caddy with that config:

   ```bash
   caddy run --config /absolute/path/to/Caddyfile
   ```

7. Open the app at `https://notes.localhost`.

In this setup, Caddy terminates HTTPS, adds `X-Forwarded-Proto: https`, and proxies to the local HTTP dev servers. Direct requests to `http://127.0.0.1:3001` are expected to fail unless you manually send that header.

## Deployment

App-user deployment on the internal server:

```bash
scripts/install-user-service.sh \
  --port 3001 \
  --sync-interval-ms 30000 \
  --git-user-name "GitHub Note Sync" \
  --git-user-email "note-sync@example.com" \
  --allowed-origin=https://notes.example.com
```

This script:
- copies the repository into `~/.local/opt/github-note-sync-server`
- overwrites `config.json` in the installed copy
- installs production dependencies with `npm ci --omit=dev`
- writes `~/.config/systemd/user/github-note-sync-server.service`
- reloads, enables, and restarts the user service

Root-side deployment guidance for both the internal app host and the external reverse proxy host:

```bash
scripts/print-root-deployment-steps.sh
```

That script prompts for the public hostname, internal IPs, ports, and app user, then prints:
- the root steps for the internal host, including `loginctl enable-linger` and firewall rules
- the nginx reverse-proxy configuration for the external host, including HTTP-to-HTTPS redirect and certificate paths
- verification commands for both machines

## Configuration

```json
{
  "port": 3001,
  "syncIntervalMs": 30000,
  "gitUserName": "GitHub Note Sync",
  "gitUserEmail": "note-sync@example.com",
  "allowedOrigins": [
    "https://notes.localhost"
  ]
}
```

These settings are optional. If `config.json` is absent, the server starts with defaults. `PORT` from the environment overrides `config.json.port`.

- `allowRegistration`: when `true`, anyone who can reach the server can self-register. Set it to `false` if you want to close signup after provisioning users.
- `sessionTtlMs`: sliding session lifetime in milliseconds.
- `sessionCookieSecure`: must be `true` when `sessionCookieSameSite` is `"none"`.
- `sessionCookieSameSite`: `"lax"`, `"strict"`, or `"none"`.
- `allowedOrigins`: explicit browser origins allowed to send credentialed requests. Loopback, private IPv4, and `.local` origins are also accepted for local testing.

## API

Auth:
- `GET /api/auth/session`: return authentication status, current user, and registration policy
- `POST /api/auth/register`: create a user account when registration is open, then start a session
- `POST /api/auth/login`: authenticate and start a session
- `POST /api/auth/logout`: revoke the current session

For non-browser clients, send `X-Session-Transport: token` on register/login to receive a `sessionToken` in the JSON response. All authenticated endpoints also accept `Authorization: Bearer <sessionToken>`.

Repo management and editing, all scoped to the authenticated user:
- `GET /api/repos`: list that user's `repoAlias` values
- `POST /api/repos`: create or return a repo alias and generate its SSH keypair
- `GET /api/repos/:repoAlias`: return non-secret metadata for one alias
- `PUT /api/repos/:repoAlias`: update the GitHub SSH repo URL for one alias
- `DELETE /api/repos/:repoAlias`: delete one alias and remove its local server data
- `GET /api/repos/:repoAlias/public-key`: return the public key for that alias
- `GET /api/bootstrap?repoAlias=<alias>`: load the file tree, sync status, `headRevision`, `stateRevision`, `mergeInProgress`, and `conflictPaths` for one repo alias
- `GET /api/file?repoAlias=<alias>&path=<path>`: read a file and return `{ content, path, revision }`
- `POST /api/ops`: apply exactly one idempotent patch op for a repo alias, using `opId`, `baseRevision`, and ordered non-overlapping `replace` ranges in `payload.ops`
- `PUT /api/file`: write a file for a repo alias as a compatibility fallback when a client cannot send a diff op
- `POST /api/files`: create a file for a repo alias
- `POST /api/folders`: create an empty UI folder for a repo alias
- `DELETE /api/folders`: delete a folder that contains no files
- `POST /api/refresh`: force-pull from the remote repo, then reload the tree and prune UI-only folders that do not exist on disk
- `POST /api/sync`: run an immediate sync for a repo alias

The server never returns private keys.

## Architecture

The server is an Express API with two server-owned state layers: authentication and repo orchestration. Authentication stores users under `$HOME/.local/github-note-sync-server/users/<userId>/profile.json`, hashes passwords with Node's built-in `scrypt`, persists opaque sessions under `$HOME/.local/github-note-sync-server/sessions`, and resolves the authenticated user from either a session cookie or a bearer token on every request. Repo state is namespaced per user under `$HOME/.local/github-note-sync-server/users/<userId>/repos/<repoAlias>`, where each alias contains metadata, a clone directory, an SSH directory, a small UI-state file, and a durable `ops-state.json` file for recent patch-op receipts. On startup the server loads optional local configuration, validates cookie/origin settings, verifies that `ssh-keygen` can successfully generate an ED25519 keypair, and deletes that startup-check keypair. A global request guard rejects any request that does not arrive with `X-Forwarded-Proto: https`, so the service is intended to sit behind a reverse proxy that terminates TLS and forwards that header. The repo manager threads `userId` through every lookup so the same `repoAlias` can exist for multiple users without collision, and the Git layer still shells out with `GIT_SSH_COMMAND` pointed at the server-generated private key for that specific user-owned alias. Transport security is intentionally external: both local HTTPS testing and production deployments are expected to terminate TLS in a reverse proxy such as Caddy or nginx before forwarding requests to this HTTP service.

The write API now has two layers. `GET /api/file` returns a content hash revision for each file, and `POST /api/ops` applies ordered range-replace patch ops against a `baseRevision`, records recent `opId` receipts for idempotent retry, and returns `409 conflict` with the server's current content when the base revision no longer matches. `PUT /api/file` remains available only as a compatibility fallback for older clients or older cached files that do not yet know a revision. The bootstrap payload now also exposes forward-compatible `headRevision`, `stateRevision`, `mergeInProgress`, and `conflictPaths` fields so the client can reason about sync state without another endpoint.

This is still the protocol-first phase of the local-first redesign, not the final merge-aware sync architecture. The periodic sync loop still uses the existing remote-overwrite behavior when the remote changes, so the richer merge-marker and explicit conflict-resolution workflow from the design document has not landed yet. The new patch-op API and revision metadata are intended to be the stable contract that later merge-aware work builds on.

Design philosophy:

- Keep identity server-owned so passwords, sessions, SSH keys, and repo authorization live in one place.
- Keep SSH private keys on the server and never expose them over the API.
- Namespace aliases by user instead of assuming a global alias space.
- Treat the remote repository as authoritative and make each local clone disposable.
- Prefer idempotent diff-based patch ops for normal text edits, but keep whole-file writes as an explicit fallback during migration.
- Accept editor keystroke-driven writes, but batch Git commits onto a sync interval to avoid noisy history.
- Keep recent op receipts durable per alias so client retries are safe when requests or responses are lost.
- Keep empty-folder UI affordances separate from Git by storing that state outside the repository clone.
- Require explicit browser origin configuration once deployments move beyond local/private-network testing.
- Keep TLS termination outside the app so local and production network topology stay aligned.
- Treat HTTPS at the reverse proxy as mandatory and reject requests that bypass that boundary.
- Keep runtime configuration local and human-editable, with simple precedence rules.
- Separate app-user service management from root-owned network and reverse-proxy changes.
