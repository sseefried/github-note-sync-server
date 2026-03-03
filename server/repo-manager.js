import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isValidRepo, isValidRepoAlias } from './config.js';
import { GitRepoService } from './git-service.js';

const execFileAsync = promisify(execFile);
const USER_ID_PATTERN = /^[0-9a-f-]{36}$/i;

function getRepoLabel(repo) {
  return repo.replace(/^git@github\.com:/, '').replace(/\.git$/, '');
}

function getUserPaths(config, userId) {
  const userDir = path.join(config.usersDir, userId);

  return {
    reposDir: path.join(userDir, 'repos'),
    userDir,
  };
}

function getAliasPaths(config, userId, repoAlias) {
  const userPaths = getUserPaths(config, userId);
  const aliasDir = path.join(userPaths.reposDir, repoAlias);
  const sshDir = path.join(aliasDir, 'ssh');

  return {
    aliasDir,
    cloneDir: path.join(aliasDir, 'clone'),
    metadataPath: path.join(aliasDir, 'metadata.json'),
    privateKeyPath: path.join(sshDir, 'id_ed25519'),
    publicKeyPath: path.join(sshDir, 'id_ed25519.pub'),
    sshDir,
    uiStatePath: path.join(aliasDir, 'ui-state.json'),
  };
}

function getServiceKey(userId, repoAlias) {
  return `${userId}:${repoAlias}`;
}

function compareTreeNodes(left, right) {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function mergeEphemeralDirectories(tree, ephemeralDirectories) {
  for (const directoryPath of ephemeralDirectories) {
    const segments = directoryPath.split('/').filter(Boolean);
    let currentNode = tree;
    let currentPath = '';

    for (const segment of segments) {
      const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
      let childNode = (currentNode.children ?? []).find(
        (child) => child.type === 'directory' && child.name === segment,
      );

      if (!childNode) {
        childNode = {
          children: [],
          name: segment,
          path: nextPath,
          type: 'directory',
        };
        currentNode.children = [...(currentNode.children ?? []), childNode].sort(compareTreeNodes);
      }

      currentNode = childNode;
      currentPath = nextPath;
    }
  }

  return tree;
}

function findTreeNode(node, targetPath) {
  if (!node) {
    return null;
  }

  if (node.path === targetPath) {
    return node;
  }

  for (const child of node.children ?? []) {
    const match = findTreeNode(child, targetPath);

    if (match) {
      return match;
    }
  }

  return null;
}

function hasFileDescendant(node) {
  if (!node) {
    return false;
  }

  if (node.type === 'file') {
    return true;
  }

  return (node.children ?? []).some((child) => hasFileDescendant(child));
}

function collectDirectoryPaths(node, paths = new Set()) {
  if (!node || node.type !== 'directory') {
    return paths;
  }

  if (node.path) {
    paths.add(node.path);
  }

  for (const child of node.children ?? []) {
    collectDirectoryPaths(child, paths);
  }

  return paths;
}

function buildRepoConfig(appConfig, userId, metadata) {
  const aliasPaths = getAliasPaths(appConfig, userId, metadata.repoAlias);

  return {
    cloneUrl: metadata.repo.endsWith('.git') ? metadata.repo : `${metadata.repo}.git`,
    gitUserEmail: appConfig.gitUserEmail,
    gitUserName: appConfig.gitUserName,
    repo: metadata.repo,
    repoAlias: metadata.repoAlias,
    repoDir: aliasPaths.cloneDir,
    repoLabel: getRepoLabel(metadata.repo),
    sshPrivateKeyPath: aliasPaths.privateKeyPath,
    syncIntervalMs: appConfig.syncIntervalMs,
    userId,
  };
}

function logSyncEvent(userId, repoAlias, reason, summary) {
  console.log(
    `[${new Date().toISOString()}] user-id=${userId} repo-alias=${repoAlias} sync=${reason} ${summary}`,
  );
}

export class RepoManager {
  constructor(config) {
    this.config = config;
    this.services = new Map();
  }

  async initialize() {
    await fs.mkdir(this.config.usersDir, { recursive: true });
    await fs.mkdir(path.dirname(this.config.sshKeygenTestDir), { recursive: true });
    await this.#verifySshKeygen();
  }

  async dispose() {
    await Promise.all([...this.services.values()].map((service) => service.dispose()));
  }

  async listRepoAliases(userId) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const entries = await fs
      .readdir(getUserPaths(this.config, normalizedUserId).reposDir, { withFileTypes: true })
      .catch(() => []);
    const aliases = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidRepoAlias(entry.name)) {
        continue;
      }

      try {
        await fs.access(getAliasPaths(this.config, normalizedUserId, entry.name).metadataPath);
        aliases.push(entry.name);
      } catch {}
    }

    return aliases.sort((left, right) => left.localeCompare(right));
  }

  async createRepoAlias(userId, repoAlias, repo) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const normalizedRepo = this.#normalizeRepo(repo);
    const aliasPaths = getAliasPaths(this.config, normalizedUserId, normalizedAlias);
    const existingMetadata = await this.#readMetadata(normalizedUserId, normalizedAlias).catch(
      () => null,
    );

    if (existingMetadata) {
      if (existingMetadata.repo !== normalizedRepo) {
        throw new Error(
          `Repo alias "${normalizedAlias}" already exists for ${existingMetadata.repo}.`,
        );
      }

      return {
        created: false,
        publicKey: await this.getPublicKey(normalizedUserId, normalizedAlias),
        repo: existingMetadata.repo,
        repoAlias: normalizedAlias,
      };
    }

    await fs.mkdir(getUserPaths(this.config, normalizedUserId).reposDir, { recursive: true });
    await fs.mkdir(aliasPaths.aliasDir, { recursive: true });
    await fs.mkdir(aliasPaths.sshDir, { recursive: true });
    await this.#generateKeyPair(aliasPaths.privateKeyPath, normalizedUserId, normalizedAlias);

    const metadata = {
      createdAt: new Date().toISOString(),
      repo: normalizedRepo,
      repoAlias: normalizedAlias,
      userId: normalizedUserId,
    };

    await fs.writeFile(aliasPaths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await this.#writeUiState(normalizedUserId, normalizedAlias, { ephemeralDirectories: [] });

    return {
      created: true,
      publicKey: await this.getPublicKey(normalizedUserId, normalizedAlias),
      repo: normalizedRepo,
      repoAlias: normalizedAlias,
    };
  }

  async getPublicKey(userId, repoAlias) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);

    try {
      return await fs.readFile(
        getAliasPaths(this.config, normalizedUserId, normalizedAlias).publicKeyPath,
        'utf8',
      );
    } catch {
      throw new Error(`No SSH public key exists for repo alias "${normalizedAlias}".`);
    }
  }

  async getRepoAliasDetails(userId, repoAlias) {
    const metadata = await this.#readMetadata(
      this.#normalizeUserId(userId),
      this.#normalizeRepoAlias(repoAlias),
    );

    return {
      repo: metadata.repo,
      repoAlias: metadata.repoAlias,
    };
  }

  async updateRepoAlias(userId, repoAlias, repo) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const normalizedRepo = this.#normalizeRepo(repo);
    const metadata = await this.#readMetadata(normalizedUserId, normalizedAlias);
    const aliasPaths = getAliasPaths(this.config, normalizedUserId, normalizedAlias);

    if (metadata.repo === normalizedRepo) {
      return {
        repo: metadata.repo,
        repoAlias: metadata.repoAlias,
        updated: false,
      };
    }

    const nextMetadata = {
      ...metadata,
      repo: normalizedRepo,
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(aliasPaths.metadataPath, `${JSON.stringify(nextMetadata, null, 2)}\n`, 'utf8');
    const serviceKey = getServiceKey(normalizedUserId, normalizedAlias);
    const service = this.services.get(serviceKey);

    if (service) {
      await service.dispose();
      this.services.delete(serviceKey);
    }

    return {
      repo: normalizedRepo,
      repoAlias: normalizedAlias,
      updated: true,
    };
  }

  async deleteRepoAlias(userId, repoAlias) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const metadata = await this.#readMetadata(normalizedUserId, normalizedAlias);
    const aliasPaths = getAliasPaths(this.config, normalizedUserId, normalizedAlias);
    const serviceKey = getServiceKey(normalizedUserId, normalizedAlias);
    const service = this.services.get(serviceKey);

    if (service) {
      await service.dispose();
      this.services.delete(serviceKey);
    }

    await fs.rm(aliasPaths.aliasDir, { recursive: true, force: true });

    return {
      deleted: true,
      repo: metadata.repo,
      repoAlias: metadata.repoAlias,
    };
  }

  async getState(userId, repoAlias) {
    try {
      const normalizedUserId = this.#normalizeUserId(userId);
      const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
      const service = await this.#ensureServiceReady(normalizedUserId, normalizedAlias, 'bootstrap');

      return {
        ready: true,
        status: service.getStatus(),
        tree: await this.#listTreeWithUiState(normalizedUserId, normalizedAlias, service),
      };
    } catch (error) {
      return {
        error: error.message,
        ready: false,
      };
    }
  }

  async readFile(userId, repoAlias, relativePath) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const service = await this.#ensureServiceReady(normalizedUserId, normalizedAlias, 'read');
    return service.readFile(relativePath);
  }

  async writeFile(userId, repoAlias, relativePath, content) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const service = await this.#ensureServiceReady(normalizedUserId, normalizedAlias, 'write');
    await service.writeFile(relativePath, content);
    return service.getStatus();
  }

  async createFile(userId, repoAlias, relativePath) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const service = await this.#ensureServiceReady(normalizedUserId, normalizedAlias, 'create file');
    await service.createFile(relativePath);
    return {
      status: service.getStatus(),
      tree: await this.#listTreeWithUiState(normalizedUserId, normalizedAlias, service),
    };
  }

  async createFolder(userId, repoAlias, parentPath, name) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const normalizedParentPath = this.#normalizeDirectoryPath(parentPath);
    const normalizedName = this.#normalizeEntryName(name, 'Folder name');
    const nextDirectoryPath = normalizedParentPath
      ? `${normalizedParentPath}/${normalizedName}`
      : normalizedName;
    const service = await this.#ensureServiceReady(
      normalizedUserId,
      normalizedAlias,
      'create folder',
    );
    const tree = await this.#listTreeWithUiState(normalizedUserId, normalizedAlias, service);

    if (normalizedParentPath && !this.#hasDirectoryPath(tree, normalizedParentPath)) {
      throw new Error(`Directory "${normalizedParentPath}" does not exist.`);
    }

    if (this.#hasDirectoryPath(tree, nextDirectoryPath)) {
      throw new Error(`Directory "${nextDirectoryPath}" already exists.`);
    }

    const uiState = await this.#readUiState(normalizedUserId, normalizedAlias);
    const nextUiState = {
      ephemeralDirectories: [...new Set([...uiState.ephemeralDirectories, nextDirectoryPath])].sort(),
    };

    await this.#writeUiState(normalizedUserId, normalizedAlias, nextUiState);

    return {
      path: nextDirectoryPath,
      status: service.getStatus(),
      tree: await this.#listTreeWithUiState(normalizedUserId, normalizedAlias, service),
    };
  }

  async deleteFolder(userId, repoAlias, folderPath) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const normalizedFolderPath = this.#normalizeDirectoryPath(folderPath);

    if (!normalizedFolderPath) {
      throw new Error('Folder path is required.');
    }

    const service = await this.#ensureServiceReady(
      normalizedUserId,
      normalizedAlias,
      'delete folder',
    );
    const tree = await this.#listTreeWithUiState(normalizedUserId, normalizedAlias, service);
    const folderNode = findTreeNode(tree, normalizedFolderPath);

    if (!folderNode || folderNode.type !== 'directory') {
      throw new Error(`Directory "${normalizedFolderPath}" does not exist.`);
    }

    if (hasFileDescendant(folderNode)) {
      throw new Error(
        `Directory "${normalizedFolderPath}" cannot be deleted because it contains files.`,
      );
    }

    const absoluteFolderPath = path.join(service.config.repoDir, normalizedFolderPath);
    await fs.rm(absoluteFolderPath, { recursive: true, force: true });

    const uiState = await this.#readUiState(normalizedUserId, normalizedAlias);
    const nextUiState = {
      ephemeralDirectories: uiState.ephemeralDirectories.filter(
        (entry) => entry !== normalizedFolderPath && !entry.startsWith(`${normalizedFolderPath}/`),
      ),
    };

    await this.#writeUiState(normalizedUserId, normalizedAlias, nextUiState);

    return {
      deleted: true,
      path: normalizedFolderPath,
      status: service.getStatus(),
      tree: await this.#listTreeWithUiState(normalizedUserId, normalizedAlias, service),
    };
  }

  async refreshTree(userId, repoAlias) {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const service = await this.#ensureServiceReady(
      normalizedUserId,
      normalizedAlias,
      'refresh tree',
    );
    await service.ensureFreshClone('manual refresh');
    const actualTree = await service.listTree();
    const actualDirectoryPaths = collectDirectoryPaths(actualTree);
    const uiState = await this.#readUiState(normalizedUserId, normalizedAlias);
    const nextUiState = {
      ephemeralDirectories: uiState.ephemeralDirectories.filter((entry) => actualDirectoryPaths.has(entry)),
    };

    await this.#writeUiState(normalizedUserId, normalizedAlias, nextUiState);

    return {
      status: service.getStatus(),
      tree: mergeEphemeralDirectories(actualTree, nextUiState.ephemeralDirectories),
    };
  }

  async syncNow(userId, repoAlias, reason = 'manual') {
    const normalizedUserId = this.#normalizeUserId(userId);
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const service = await this.#ensureServiceReady(normalizedUserId, normalizedAlias, reason);
    logSyncEvent(normalizedUserId, normalizedAlias, reason, 'started');

    const result = await service.syncNow(reason);
    logSyncEvent(normalizedUserId, normalizedAlias, reason, `completed result=${result.kind}`);

    return {
      result,
      status: service.getStatus(),
      tree: await this.#listTreeWithUiState(normalizedUserId, normalizedAlias, service),
    };
  }

  async syncActiveRepos() {
    await Promise.all(
      [...this.services.values()].map(async (service) => {
        if (!service.initialized) {
          return;
        }

        try {
          logSyncEvent(service.config.userId, service.config.repoAlias, 'interval', 'started');
          await service.syncNow('interval');
          logSyncEvent(
            service.config.userId,
            service.config.repoAlias,
            'interval',
            `completed status=${service.getStatus().lastSyncStatus}`,
          );
        } catch (error) {
          logSyncEvent(
            service.config.userId,
            service.config.repoAlias,
            'interval',
            `failed error=${error.message}`,
          );
          console.error(error);
        }
      }),
    );
  }

  async #ensureServiceReady(userId, repoAlias, reason) {
    const metadata = await this.#readMetadata(userId, repoAlias);
    const service = this.#getService(userId, metadata);
    await service.ensureReady(reason);
    return service;
  }

  #getService(userId, metadata) {
    const serviceKey = getServiceKey(userId, metadata.repoAlias);

    if (!this.services.has(serviceKey)) {
      this.services.set(serviceKey, new GitRepoService(buildRepoConfig(this.config, userId, metadata)));
    }

    return this.services.get(serviceKey);
  }

  async #readMetadata(userId, repoAlias) {
    let rawMetadata;

    try {
      rawMetadata = await fs.readFile(getAliasPaths(this.config, userId, repoAlias).metadataPath, 'utf8');
    } catch {
      throw new Error(`Repo alias "${repoAlias}" does not exist.`);
    }

    let metadata;

    try {
      metadata = JSON.parse(rawMetadata);
    } catch (error) {
      throw new Error(`Metadata for repo alias "${repoAlias}" is invalid: ${error.message}`);
    }

    if (
      typeof metadata.repoAlias !== 'string' ||
      typeof metadata.repo !== 'string' ||
      !isValidRepoAlias(metadata.repoAlias) ||
      !isValidRepo(metadata.repo)
    ) {
      throw new Error(`Metadata for repo alias "${repoAlias}" is invalid.`);
    }

    return metadata;
  }

  async #readUiState(userId, repoAlias) {
    let rawUiState;

    try {
      rawUiState = await fs.readFile(getAliasPaths(this.config, userId, repoAlias).uiStatePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { ephemeralDirectories: [] };
      }

      throw error;
    }

    try {
      const parsed = JSON.parse(rawUiState);
      const ephemeralDirectories = Array.isArray(parsed.ephemeralDirectories)
        ? parsed.ephemeralDirectories
            .filter((entry) => typeof entry === 'string')
            .map((entry) => this.#normalizeDirectoryPath(entry))
            .filter(Boolean)
        : [];

      return {
        ephemeralDirectories: [...new Set(ephemeralDirectories)].sort(),
      };
    } catch (error) {
      throw new Error(`UI state for repo alias "${repoAlias}" is invalid: ${error.message}`);
    }
  }

  async #writeUiState(userId, repoAlias, uiState) {
    const aliasPaths = getAliasPaths(this.config, userId, repoAlias);
    await fs.writeFile(aliasPaths.uiStatePath, `${JSON.stringify(uiState, null, 2)}\n`, 'utf8');
  }

  async #listTreeWithUiState(userId, repoAlias, service) {
    const tree = await service.listTree();
    const uiState = await this.#readUiState(userId, repoAlias);
    return mergeEphemeralDirectories(tree, uiState.ephemeralDirectories);
  }

  #hasDirectoryPath(node, targetPath) {
    const match = findTreeNode(node, targetPath);
    return match?.type === 'directory';
  }

  async #generateKeyPair(privateKeyPath, userId, repoAlias) {
    try {
      await execFileAsync('ssh-keygen', [
        '-t',
        'ed25519',
        '-N',
        '',
        '-f',
        privateKeyPath,
        '-C',
        `github-note-sync-server:${userId}:${repoAlias}`,
      ]);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('ssh-keygen is not available on this machine.');
      }

      const stderr = error.stderr?.toString().trim();
      const stdout = error.stdout?.toString().trim();
      throw new Error(stderr || stdout || error.message);
    }
  }

  async #verifySshKeygen() {
    const testDir = this.config.sshKeygenTestDir;
    const testKeyPath = path.join(testDir, 'id_ed25519');

    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });

    try {
      const result = await execFileAsync('ssh-keygen', [
        '-t',
        'ed25519',
        '-N',
        '',
        '-f',
        testKeyPath,
        '-C',
        'github-note-sync-server-startup-check',
      ]);
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();

      if (!output.includes('ed25519')) {
        throw new Error('ssh-keygen ran, but its output did not mention ed25519.');
      }

      await fs.access(testKeyPath);
      await fs.access(`${testKeyPath}.pub`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('ssh-keygen is not installed or not available in PATH.');
      }

      throw new Error(`ssh-keygen startup check failed: ${error.message}`);
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  }

  #normalizeUserId(userId) {
    const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';

    if (!USER_ID_PATTERN.test(normalizedUserId)) {
      throw new Error('Invalid user id.');
    }

    return normalizedUserId;
  }

  #normalizeRepoAlias(repoAlias) {
    const normalizedAlias = typeof repoAlias === 'string' ? repoAlias.trim() : '';

    if (!isValidRepoAlias(normalizedAlias)) {
      throw new Error(
        'repoAlias must contain only letters, numbers, underscores, and hyphens.',
      );
    }

    return normalizedAlias;
  }

  #normalizeRepo(repo) {
    const normalizedRepo = typeof repo === 'string' ? repo.trim() : '';

    if (!isValidRepo(normalizedRepo)) {
      throw new Error(
        'repo must look like git@github.com:<username>/<repo> or git@github.com:<username>/<repo>.git.',
      );
    }

    return normalizedRepo;
  }

  #normalizeDirectoryPath(relativePath) {
    const trimmedPath = typeof relativePath === 'string' ? relativePath.trim() : '';

    if (trimmedPath === '') {
      return '';
    }

    const normalizedPath = path.posix
      .normalize(trimmedPath.replace(/\\/g, '/').replace(/^\/+/, ''))
      .replace(/\/+$/, '');

    if (
      normalizedPath === '' ||
      normalizedPath === '.' ||
      normalizedPath === '..' ||
      normalizedPath.startsWith('../') ||
      normalizedPath.includes('/../') ||
      normalizedPath === '.git' ||
      normalizedPath.startsWith('.git/')
    ) {
      throw new Error(`Invalid directory path: ${relativePath}`);
    }

    return normalizedPath;
  }

  #normalizeEntryName(name, label) {
    const normalizedName = typeof name === 'string' ? name.trim() : '';

    if (
      normalizedName === '' ||
      normalizedName === '.' ||
      normalizedName === '..' ||
      normalizedName === '.git' ||
      /[\\/]/.test(normalizedName)
    ) {
      throw new Error(`${label} must be a simple name without path separators.`);
    }

    return normalizedName;
  }
}
