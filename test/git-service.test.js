import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitRepoService } from '../server/git-service.js';

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function createRepoFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'github-note-sync-server-'));
  const remoteDir = path.join(tempRoot, 'remote.git');
  const authorDir = path.join(tempRoot, 'author');
  const cloneDir = path.join(tempRoot, 'clone');

  await fs.mkdir(authorDir, { recursive: true });

  runGit(['init', '--bare', '--initial-branch=main', remoteDir], tempRoot);
  runGit(['init', '--initial-branch=main'], authorDir);
  runGit(['config', 'user.name', 'Fixture User'], authorDir);
  runGit(['config', 'user.email', 'fixture@example.com'], authorDir);
  await fs.mkdir(path.join(authorDir, 'notes'), { recursive: true });
  await fs.writeFile(path.join(authorDir, 'notes', 'today.md'), 'first line\n', 'utf8');
  runGit(['add', '-A'], authorDir);
  runGit(['commit', '-m', 'Initial commit'], authorDir);
  runGit(['remote', 'add', 'origin', remoteDir], authorDir);
  runGit(['push', '-u', 'origin', 'main'], authorDir);

  const service = new GitRepoService({
    cloneUrl: remoteDir,
    gitUserEmail: 'server@example.com',
    gitUserName: 'Server Test',
    opsStatePath: path.join(tempRoot, 'ops-state.json'),
    repo: 'git@github.com:test/notes.git',
    repoAlias: 'notes',
    repoDir: cloneDir,
    repoLabel: 'test/notes',
    sshPrivateKeyPath: path.join(tempRoot, 'id_ed25519'),
    syncIntervalMs: 30_000,
    userId: '00000000-0000-0000-0000-000000000000',
  });

  await service.ensureReady('test');

  return {
    async cleanup() {
      await service.dispose();
      await fs.rm(tempRoot, { force: true, recursive: true });
    },
    remoteDir,
    service,
  };
}

test('applyOps applies patches, detects true duplicates, and surfaces revision conflicts', async (t) => {
  const fixture = await createRepoFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const { service } = fixture;
  const initialFileState = await service.readFileState('notes/today.md');
  const patchOp = {
    baseRevision: initialFileState.revision,
    kind: 'patch',
    opId: 'op-1',
    path: 'notes/today.md',
    payload: {
      ops: [
        {
          from: initialFileState.content.length,
          text: 'second line\n',
          to: initialFileState.content.length,
          type: 'replace',
        },
      ],
    },
  };

  const appliedResult = await service.applyOps([patchOp]);
  assert.equal(appliedResult.outcomes[0].status, 'applied');
  assert.equal(await service.readFile('notes/today.md'), 'first line\nsecond line\n');

  const duplicateResult = await service.applyOps([patchOp]);
  assert.equal(duplicateResult.outcomes[0].status, 'duplicate');

  await service.writeFile('notes/today.md', initialFileState.content);

  const replayedResult = await service.applyOps([patchOp]);
  assert.equal(replayedResult.outcomes[0].status, 'applied');
  assert.equal(await service.readFile('notes/today.md'), 'first line\nsecond line\n');

  await assert.rejects(
    () =>
      service.applyOps([
        {
          baseRevision: initialFileState.revision,
          kind: 'patch',
          opId: 'op-2',
          path: 'notes/today.md',
          payload: {
            ops: [{ from: 0, text: 'updated line\n', to: 11, type: 'replace' }],
          },
        },
      ]),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.payload.error, 'conflict');
      assert.equal(error.payload.path, 'notes/today.md');
      assert.equal(error.payload.currentContent, 'first line\nsecond line\n');
      return true;
    },
  );
});

test('commitConflictMarkers creates and pushes an ordinary commit with git conflict markers', async (t) => {
  const fixture = await createRepoFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const { remoteDir, service } = fixture;
  const initialBaseCommit = await service.getHeadRevision();

  await service.writeFile('notes/today.md', 'desktop line\n');
  await service.syncNow('desktop update');

  const result = await service.commitConflictMarkers({
    baseCommit: initialBaseCommit,
    localContent: 'mobile line\n',
    relativePath: 'notes/today.md',
  });

  assert.equal(result.file.path, 'notes/today.md');
  assert.match(result.file.content, /<<<<<<< /);
  assert.match(result.file.content, /mobile line/);
  assert.match(result.file.content, /desktop line/);
  assert.match(result.file.content, />>>>>>> /);

  const remoteContent = runGit(['show', 'main:notes/today.md'], remoteDir);
  assert.equal(remoteContent, result.file.content.trimEnd());
  assert.doesNotMatch(runGit(['branch', '--list'], fixture.service.config.repoDir), /github-note-sync-temp-/);
});

test('commitConflictMarkers cleanly auto-merges non-overlapping edits without markers', async (t) => {
  const fixture = await createRepoFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const { service } = fixture;
  await service.writeFile('notes/today.md', 'first line\nsecond line\nthird line\n');
  await service.syncNow('prepare multi-line base');

  const baseCommit = await service.getHeadRevision();

  await service.writeFile('notes/today.md', 'first line\nsecond line\nremote third line\n');
  await service.syncNow('desktop update');

  const result = await service.commitConflictMarkers({
    baseCommit,
    localContent: 'local first line\nsecond line\nthird line\n',
    relativePath: 'notes/today.md',
  });

  assert.doesNotMatch(result.file.content, /<<<<<<<|=======|>>>>>>>/);
  assert.match(result.file.content, /local first line/);
  assert.match(result.file.content, /remote third line/);
});

test('commitConflictMarkers rejects requests without a base commit', async (t) => {
  const fixture = await createRepoFixture();
  t.after(async () => {
    await fixture.cleanup();
  });

  const { service } = fixture;

  await assert.rejects(
    () =>
      service.commitConflictMarkers({
        localContent: 'local version\n',
        relativePath: 'notes/today.md',
      }),
    /baseCommit/,
  );
});
