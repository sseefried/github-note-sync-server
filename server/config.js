import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const APP_ROOT = process.cwd();
export const CONFIG_PATH = path.join(APP_ROOT, 'config.json');
export const DEFAULT_PORT = 3001;
export const DEFAULT_SYNC_INTERVAL_MS = 30_000;
export const SERVER_DATA_DIR = path.join(os.homedir(), '.local', 'github-note-sync-server');
export const REPOS_DIR = path.join(SERVER_DATA_DIR, 'repos');
export const SSH_KEYGEN_TEST_DIR = path.join(SERVER_DATA_DIR, 'runtime', 'ssh-keygen-self-test');

const REPO_PATTERN = /^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function isValidRepo(repo) {
  return REPO_PATTERN.test(repo);
}

export function isValidRepoAlias(repoAlias) {
  return ALIAS_PATTERN.test(repoAlias);
}

export async function loadConfig() {
  let parsed = {};

  try {
    const rawConfig = await fs.readFile(CONFIG_PATH, 'utf8');

    try {
      parsed = JSON.parse(rawConfig);
    } catch (error) {
      throw new ConfigError(`config.json is not valid JSON: ${error.message}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const syncIntervalMs =
    Number.isInteger(parsed.syncIntervalMs) && parsed.syncIntervalMs > 0
      ? parsed.syncIntervalMs
      : DEFAULT_SYNC_INTERVAL_MS;
  const configuredPort =
    Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65_535
      ? parsed.port
      : DEFAULT_PORT;

  if (
    typeof parsed.port !== 'undefined' &&
    (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65_535)
  ) {
    throw new ConfigError('config.json "port" must be an integer between 1 and 65535.');
  }

  if (
    typeof parsed.gitUserName !== 'undefined' &&
    (typeof parsed.gitUserName !== 'string' || parsed.gitUserName.trim() === '')
  ) {
    throw new ConfigError('config.json "gitUserName" must be a non-empty string when provided.');
  }

  if (
    typeof parsed.gitUserEmail !== 'undefined' &&
    (typeof parsed.gitUserEmail !== 'string' || parsed.gitUserEmail.trim() === '')
  ) {
    throw new ConfigError('config.json "gitUserEmail" must be a non-empty string when provided.');
  }

  return {
    appRoot: APP_ROOT,
    dataDir: SERVER_DATA_DIR,
    reposDir: REPOS_DIR,
    sshKeygenTestDir: SSH_KEYGEN_TEST_DIR,
    port:
      Number.isInteger(Number.parseInt(process.env.PORT ?? '', 10)) &&
      Number.parseInt(process.env.PORT ?? '', 10) > 0 &&
      Number.parseInt(process.env.PORT ?? '', 10) <= 65_535
        ? Number.parseInt(process.env.PORT ?? '', 10)
        : configuredPort,
    syncIntervalMs,
    gitUserName:
      typeof parsed.gitUserName === 'string' && parsed.gitUserName.trim() !== ''
        ? parsed.gitUserName.trim()
        : 'GitHub Note Sync',
    gitUserEmail:
      typeof parsed.gitUserEmail === 'string' && parsed.gitUserEmail.trim() !== ''
        ? parsed.gitUserEmail.trim()
        : 'note-sync@local',
  };
}
