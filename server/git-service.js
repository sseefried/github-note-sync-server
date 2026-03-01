import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export class GitRepoService {
  constructor(config) {
    this.config = config;
    this.branch = null;
    this.baseRemoteHead = null;
    this.stateVersion = 0;
    this.lastSyncAt = null;
    this.lastSyncStatus = 'starting';
    this.lastSyncMessage = 'Preparing repository clone.';
    this.dirtyPaths = new Set();
    this.syncPromise = null;
    this.initialized = false;
  }

  async ensureReady(reason = 'startup') {
    if (this.initialized && (await this.#hasClone())) {
      return;
    }

    await this.ensureFreshClone(reason);
    this.initialized = true;
  }

  async dispose() {}

  async ensureFreshClone(reason = 'refresh') {
    await fs.mkdir(path.dirname(this.config.repoDir), { recursive: true });

    if (!(await this.#hasClone())) {
      await this.#cloneRepository();
    }

    await this.#syncRemoteMetadata();
    await this.#configureCommitIdentity();
    await this.#resetToRemote(`Clone matches origin/${this.branch} after ${reason}.`);
  }

  async getState() {
    return {
      tree: await this.listTree(),
      status: this.getStatus(),
    };
  }

  getStatus() {
    return {
      repoAlias: this.config.repoAlias,
      branch: this.branch,
      repo: this.config.repoLabel,
      syncIntervalMs: this.config.syncIntervalMs,
      dirtyPaths: [...this.dirtyPaths].sort(),
      lastSyncAt: this.lastSyncAt,
      lastSyncStatus: this.lastSyncStatus,
      lastSyncMessage: this.lastSyncMessage,
      stateVersion: this.stateVersion,
      activeSync: this.syncPromise !== null,
    };
  }

  async listTree() {
    return {
      type: 'directory',
      name: this.config.repoLabel.split('/').pop(),
      path: '',
      children: await this.#walkDirectory(this.config.repoDir, ''),
    };
  }

  async readFile(relativePath) {
    const absolutePath = this.#resolveRepoPath(relativePath);
    return fs.readFile(absolutePath, 'utf8');
  }

  async createFile(relativePath) {
    const absolutePath = this.#resolveRepoPath(relativePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    try {
      await fs.access(absolutePath);
      throw new Error(`${relativePath} already exists.`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.writeFile(absolutePath, '', 'utf8');
    this.dirtyPaths.add(relativePath);
    this.stateVersion += 1;
    this.lastSyncStatus = 'dirty';
    this.lastSyncMessage = `Unsynced edits in ${relativePath}.`;
  }

  async writeFile(relativePath, content) {
    const absolutePath = this.#resolveRepoPath(relativePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');

    this.dirtyPaths.add(relativePath);
    this.stateVersion += 1;
    this.lastSyncStatus = 'dirty';
    this.lastSyncMessage = `Unsynced edits in ${relativePath}.`;
  }

  async syncNow(reason = 'manual') {
    await this.ensureReady(reason);

    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.#performSync(reason).finally(() => {
      this.syncPromise = null;
    });

    return this.syncPromise;
  }

  async #performSync(reason) {
    this.lastSyncStatus = 'syncing';
    this.lastSyncMessage = `Syncing with origin/${this.branch} (${reason}).`;
    this.stateVersion += 1;

    try {
      await this.#git(['fetch', '--prune', 'origin']);

      const remoteHead = await this.#git(['rev-parse', `origin/${this.branch}`]);
      const localHead = await this.#git(['rev-parse', 'HEAD']);
      const remoteChanged = remoteHead !== this.baseRemoteHead || remoteHead !== localHead;

      if (remoteChanged) {
        await this.#resetToRemote(
          `Remote changed on origin/${this.branch}; local clone was overwritten.`,
        );
        this.lastSyncStatus = 'overwritten';
        this.lastSyncMessage = `Remote changed on origin/${this.branch}; local clone was overwritten.`;
        return { kind: 'overwritten' };
      }

      const statusOutput = await this.#git(['status', '--porcelain']);

      if (statusOutput.trim() === '') {
        this.lastSyncStatus = 'idle';
        this.lastSyncMessage = 'No local changes to sync.';
        this.lastSyncAt = new Date().toISOString();
        this.stateVersion += 1;
        return { kind: 'noop' };
      }

      await this.#git(['add', '-A']);
      await this.#git(['commit', '-m', `Auto-sync ${new Date().toISOString()}`]);
      await this.#git(['push', 'origin', `HEAD:${this.branch}`]);

      this.baseRemoteHead = await this.#git(['rev-parse', 'HEAD']);
      this.dirtyPaths.clear();
      this.lastSyncStatus = 'pushed';
      this.lastSyncMessage = `Pushed local edits to origin/${this.branch}.`;
      this.lastSyncAt = new Date().toISOString();
      this.stateVersion += 1;

      return { kind: 'pushed' };
    } catch (error) {
      try {
        await this.#syncRemoteMetadata();
        await this.#resetToRemote('Remote state reapplied after sync failure.');
        this.lastSyncStatus = 'overwritten';
        this.lastSyncMessage = `Remote state reapplied after sync failure: ${error.message}`;
        this.lastSyncAt = new Date().toISOString();
        this.stateVersion += 1;
        return { kind: 'overwritten', error: error.message };
      } catch (resetError) {
        this.lastSyncStatus = 'error';
        this.lastSyncMessage = resetError.message;
        this.lastSyncAt = new Date().toISOString();
        this.stateVersion += 1;
        throw resetError;
      }
    }
  }

  async #hasClone() {
    try {
      await fs.access(path.join(this.config.repoDir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  async #cloneRepository() {
    await fs.rm(this.config.repoDir, { recursive: true, force: true });
    await this.#git(['clone', this.config.cloneUrl, this.config.repoDir], {
      cwd: path.dirname(this.config.repoDir),
    });
  }

  async #configureCommitIdentity() {
    await this.#git(['config', 'user.name', this.config.gitUserName]);
    await this.#git(['config', 'user.email', this.config.gitUserEmail]);
  }

  async #syncRemoteMetadata() {
    await this.#git(['fetch', '--prune', 'origin']);

    try {
      const remoteHeadRef = await this.#git([
        'symbolic-ref',
        '--short',
        'refs/remotes/origin/HEAD',
      ]);
      this.branch = remoteHeadRef.replace(/^origin\//, '');
    } catch {
      this.branch = await this.#git(['rev-parse', '--abbrev-ref', 'HEAD']);
    }

    this.baseRemoteHead = await this.#git(['rev-parse', `origin/${this.branch}`]);
  }

  async #resetToRemote(message) {
    await this.#git(['checkout', '-B', this.branch, `origin/${this.branch}`]);
    await this.#git(['reset', '--hard', `origin/${this.branch}`]);
    await this.#git(['clean', '-fd']);

    this.baseRemoteHead = await this.#git(['rev-parse', `origin/${this.branch}`]);
    this.dirtyPaths.clear();
    this.lastSyncAt = new Date().toISOString();
    this.lastSyncStatus = 'ready';
    this.lastSyncMessage = message;
    this.stateVersion += 1;
  }

  async #walkDirectory(absoluteDirectory, relativeDirectory) {
    const entries = sortEntries(
      (await fs.readdir(absoluteDirectory, { withFileTypes: true })).filter(
        (entry) => entry.name !== '.git' && !entry.isSymbolicLink(),
      ),
    );

    const children = [];

    for (const entry of entries) {
      const childRelativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const childAbsolutePath = path.join(absoluteDirectory, entry.name);

      if (entry.isDirectory()) {
        children.push({
          type: 'directory',
          name: entry.name,
          path: childRelativePath,
          children: await this.#walkDirectory(childAbsolutePath, childRelativePath),
        });
        continue;
      }

      children.push({
        type: 'file',
        name: entry.name,
        path: childRelativePath,
      });
    }

    return children;
  }

  #resolveRepoPath(relativePath) {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');

    if (normalizedPath === '') {
      throw new Error('File path is required.');
    }

    const absolutePath = path.resolve(this.config.repoDir, normalizedPath);
    const relativeFromRepo = path.relative(this.config.repoDir, absolutePath);

    if (
      relativeFromRepo.startsWith('..') ||
      path.isAbsolute(relativeFromRepo) ||
      normalizedPath.startsWith('.git')
    ) {
      throw new Error(`Invalid file path: ${relativePath}`);
    }

    return absolutePath;
  }

  async #git(args, options = {}) {
    const cwd = options.cwd ?? this.config.repoDir;

    try {
      const result = await execFileAsync('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_SSH_COMMAND: `ssh -i ${this.config.sshPrivateKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
        },
        maxBuffer: MAX_BUFFER,
      });

      return result.stdout.trim();
    } catch (error) {
      const stderr = error.stderr?.toString().trim();
      const stdout = error.stdout?.toString().trim();
      const output = stderr || stdout || error.message;
      throw new Error(`git ${args.join(' ')} failed: ${output}`);
    }
  }
}
