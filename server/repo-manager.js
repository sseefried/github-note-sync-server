import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isValidRepo, isValidRepoAlias } from './config.js';
import { GitRepoService } from './git-service.js';

const execFileAsync = promisify(execFile);

function getRepoLabel(repo) {
  return repo.replace(/^git@github\.com:/, '').replace(/\.git$/, '');
}

function getAliasPaths(config, repoAlias) {
  const aliasDir = path.join(config.reposDir, repoAlias);
  const sshDir = path.join(aliasDir, 'ssh');

  return {
    aliasDir,
    cloneDir: path.join(aliasDir, 'clone'),
    metadataPath: path.join(aliasDir, 'metadata.json'),
    privateKeyPath: path.join(sshDir, 'id_ed25519'),
    publicKeyPath: path.join(sshDir, 'id_ed25519.pub'),
    sshDir,
  };
}

function buildRepoConfig(appConfig, metadata) {
  const aliasPaths = getAliasPaths(appConfig, metadata.repoAlias);

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
  };
}

export class RepoManager {
  constructor(config) {
    this.config = config;
    this.services = new Map();
  }

  async initialize() {
    await fs.mkdir(this.config.reposDir, { recursive: true });
    await fs.mkdir(path.dirname(this.config.sshKeygenTestDir), { recursive: true });
    await this.#verifySshKeygen();
  }

  async dispose() {
    await Promise.all([...this.services.values()].map((service) => service.dispose()));
  }

  async listRepoAliases() {
    const entries = await fs.readdir(this.config.reposDir, { withFileTypes: true }).catch(() => []);
    const aliases = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidRepoAlias(entry.name)) {
        continue;
      }

      try {
        await fs.access(getAliasPaths(this.config, entry.name).metadataPath);
        aliases.push(entry.name);
      } catch {}
    }

    return aliases.sort((left, right) => left.localeCompare(right));
  }

  async createRepoAlias(repoAlias, repo) {
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);
    const normalizedRepo = this.#normalizeRepo(repo);
    const aliasPaths = getAliasPaths(this.config, normalizedAlias);
    const existingMetadata = await this.#readMetadata(normalizedAlias).catch(() => null);

    if (existingMetadata) {
      if (existingMetadata.repo !== normalizedRepo) {
        throw new Error(
          `Repo alias "${normalizedAlias}" already exists for ${existingMetadata.repo}.`,
        );
      }

      return {
        created: false,
        publicKey: await this.getPublicKey(normalizedAlias),
        repo: existingMetadata.repo,
        repoAlias: normalizedAlias,
      };
    }

    await fs.mkdir(aliasPaths.aliasDir, { recursive: true });
    await fs.mkdir(aliasPaths.sshDir, { recursive: true });
    await this.#generateKeyPair(aliasPaths.privateKeyPath, normalizedAlias);

    const metadata = {
      createdAt: new Date().toISOString(),
      repo: normalizedRepo,
      repoAlias: normalizedAlias,
    };

    await fs.writeFile(aliasPaths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    return {
      created: true,
      publicKey: await this.getPublicKey(normalizedAlias),
      repo: normalizedRepo,
      repoAlias: normalizedAlias,
    };
  }

  async getPublicKey(repoAlias) {
    const normalizedAlias = this.#normalizeRepoAlias(repoAlias);

    try {
      return await fs.readFile(getAliasPaths(this.config, normalizedAlias).publicKeyPath, 'utf8');
    } catch {
      throw new Error(`No SSH public key exists for repo alias "${normalizedAlias}".`);
    }
  }

  async getState(repoAlias) {
    try {
      const service = await this.#ensureServiceReady(repoAlias, 'bootstrap');

      return {
        ready: true,
        ...(await service.getState()),
      };
    } catch (error) {
      return {
        ready: false,
        error: error.message,
      };
    }
  }

  async readFile(repoAlias, relativePath) {
    const service = await this.#ensureServiceReady(repoAlias, 'read');
    return service.readFile(relativePath);
  }

  async writeFile(repoAlias, relativePath, content) {
    const service = await this.#ensureServiceReady(repoAlias, 'write');
    await service.writeFile(relativePath, content);
    return service.getStatus();
  }

  async createFile(repoAlias, relativePath) {
    const service = await this.#ensureServiceReady(repoAlias, 'create file');
    await service.createFile(relativePath);
    return service.getStatus();
  }

  async syncNow(repoAlias, reason = 'manual') {
    const service = await this.#ensureServiceReady(repoAlias, reason);

    return {
      result: await service.syncNow(reason),
      status: service.getStatus(),
      tree: await service.listTree(),
    };
  }

  async syncActiveRepos() {
    await Promise.all(
      [...this.services.values()].map(async (service) => {
        if (!service.initialized) {
          return;
        }

        try {
          await service.syncNow('interval');
        } catch (error) {
          console.error(error);
        }
      }),
    );
  }

  async #ensureServiceReady(repoAlias, reason) {
    const metadata = await this.#readMetadata(this.#normalizeRepoAlias(repoAlias));
    const service = this.#getService(metadata);
    await service.ensureReady(reason);
    return service;
  }

  #getService(metadata) {
    if (!this.services.has(metadata.repoAlias)) {
      this.services.set(metadata.repoAlias, new GitRepoService(buildRepoConfig(this.config, metadata)));
    }

    return this.services.get(metadata.repoAlias);
  }

  async #readMetadata(repoAlias) {
    let rawMetadata;

    try {
      rawMetadata = await fs.readFile(getAliasPaths(this.config, repoAlias).metadataPath, 'utf8');
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

  async #generateKeyPair(privateKeyPath, repoAlias) {
    try {
      await execFileAsync('ssh-keygen', [
        '-t',
        'ed25519',
        '-N',
        '',
        '-f',
        privateKeyPath,
        '-C',
        `github-note-sync-server:${repoAlias}`,
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
}
