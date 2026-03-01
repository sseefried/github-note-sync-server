# GitHub Note Sync Server

The server repository owns per-repository local Git clones, generates SSH keys for each repo alias, applies text-file edits received from the web client, and periodically syncs those edits to GitHub. Each repo alias is isolated under a server-managed data directory, and the remote repository remains authoritative: if origin moves ahead, the server overwrites its local clone to match.

## Installation

1. Install Node.js 25+ and npm.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Ensure `ssh-keygen` is installed and available in `PATH`.
4. Optionally copy `config.json.example` to `config.json` if you want to override the sync interval or commit identity.

## Usage

1. Start the API in development:

   ```bash
   npm run dev
   ```

2. Or start it normally:

   ```bash
   npm start
   ```

3. The API listens on `http://localhost:3001` by default.
4. Register a repo alias from the client or via `POST /api/repos` with:
   - `repoAlias`: letters, numbers, `_`, and `-` only
   - `repo`: `git@github.com:<username>/<repo>` or `git@github.com:<username>/<repo>.git`
5. Fetch the public key from `GET /api/repos/:repoAlias/public-key` and add it to GitHub so the server can clone and push.
6. All server data lives under `$HOME/.local/github-note-sync-server`.
7. Each sync attempt is logged to stdout with an ISO timestamp and the `repoAlias`.

## Configuration

```json
{
  "syncIntervalMs": 30000,
  "gitUserName": "GitHub Note Sync",
  "gitUserEmail": "note-sync@example.com"
}
```

These settings are optional. If `config.json` is absent, the server starts with defaults.

## API

- `GET /api/repos`: list all registered `repoAlias` values
- `POST /api/repos`: create or return a repo alias and generate its SSH keypair
- `GET /api/repos/:repoAlias`: return non-secret metadata for one alias
- `PUT /api/repos/:repoAlias`: update the GitHub SSH repo URL for one alias
- `DELETE /api/repos/:repoAlias`: delete one alias and remove its local server data
- `GET /api/repos/:repoAlias/public-key`: return the public key for that alias
- `GET /api/bootstrap?repoAlias=<alias>`: load the file tree and sync status for one repo alias
- `GET /api/file?repoAlias=<alias>&path=<path>`: read a file
- `PUT /api/file`: write a file for a repo alias
- `POST /api/files`: create a file for a repo alias
- `POST /api/folders`: create an empty UI folder for a repo alias
- `DELETE /api/folders`: delete a folder that contains no files
- `POST /api/refresh`: force-pull from the remote repo, then reload the tree and prune UI-only folders that do not exist on disk
- `POST /api/sync`: run an immediate sync for a repo alias

The server never returns private keys.

## Architecture

The server is an Express API with a repo manager and a per-alias Git orchestration layer. On startup it verifies that `ssh-keygen` exists and can successfully generate an ED25519 keypair, then deletes that startup-check keypair. Repo aliases are stored under `$HOME/.local/github-note-sync-server/repos/<repoAlias>`, with metadata, SSH keys, a clone directory, and a small UI-state file isolated from each other. The API lets the client create aliases, retrieve public keys, update alias metadata, delete aliases and their local server state, create and delete empty folders, force-refresh by fetching and hard-resetting to the remote repo before rebuilding the tree, and then operate on one alias at a time. The Git layer uses shell `git` commands with `GIT_SSH_COMMAND` pointing at the server-generated private key for that alias, and the repo manager logs each sync attempt with its alias and timestamp while merging ephemeral empty-folder state into the returned tree.

Design philosophy:

- Keep the state model explicit: Git working tree plus remote history are the persistence layer for each alias.
- Treat the remote repository as authoritative and make each local clone disposable.
- Generate and store SSH keys on the server so private keys never need to leave the machine.
- Accept editor keystroke-driven writes, but batch Git commits onto a sync interval to avoid noisy history.
- Keep empty-folder UI affordances separate from Git by storing that state outside the repository clone.
- Let the UI explicitly reconcile against the remote repo so ephemeral folder state can be discarded on demand.
- Keep server data in one predictable home-directory location.
