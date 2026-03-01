import cors from 'cors';
import express from 'express';
import { loadConfig } from './config.js';
import { RepoManager } from './repo-manager.js';

const app = express();
const port = Number.parseInt(process.env.PORT ?? '3001', 10);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

let repoManager = null;
let startupError = null;
let syncTimer = null;

function sendError(response, error, status = 500) {
  response.status(status).json({ error: error.message });
}

async function bootstrap() {
  try {
    const config = await loadConfig();
    const manager = new RepoManager(config);
    await manager.initialize();

    repoManager = manager;
    startupError = null;

    syncTimer = setInterval(() => {
      repoManager.syncActiveRepos().catch((error) => {
        console.error(error);
      });
    }, config.syncIntervalMs);
  } catch (error) {
    startupError = error;
    console.error(error);
  }
}

function requireRepoManager(response) {
  if (!repoManager) {
    response.status(503).json({
      error:
        startupError?.message ??
        'Repository service is not available. Check the server logs and restart the server.',
    });
    return null;
  }

  return repoManager;
}

function getRepoAliasFromRequest(request) {
  if (typeof request.query.repoAlias === 'string') {
    return request.query.repoAlias;
  }

  if (typeof request.body?.repoAlias === 'string') {
    return request.body.repoAlias;
  }

  return '';
}

app.get('/api/repos', async (_request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    response.json({
      repoAliases: await manager.listRepoAliases(),
    });
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/api/repos', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const { repoAlias, repo } = request.body ?? {};

    if (typeof repoAlias !== 'string' || typeof repo !== 'string') {
      return response
        .status(400)
        .json({ error: 'Request body must include "repoAlias" and "repo" strings.' });
    }

    const result = await manager.createRepoAlias(repoAlias, repo);
    response.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.get('/api/repos/:repoAlias/public-key', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    response.json({
      publicKey: await manager.getPublicKey(request.params.repoAlias),
      repoAlias: request.params.repoAlias,
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.get('/api/repos/:repoAlias', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    response.json(await manager.getRepoAliasDetails(request.params.repoAlias));
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.put('/api/repos/:repoAlias', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const { repo } = request.body ?? {};

    if (typeof repo !== 'string') {
      return response.status(400).json({ error: 'Request body must include a "repo" string.' });
    }

    response.json(await manager.updateRepoAlias(request.params.repoAlias, repo));
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.delete('/api/repos/:repoAlias', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    response.json(await manager.deleteRepoAlias(request.params.repoAlias));
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.get('/api/bootstrap', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  const repoAlias = getRepoAliasFromRequest(request);

  if (!repoAlias) {
    return response.status(400).json({ error: 'repoAlias is required.' });
  }

  return response.json(await manager.getState(repoAlias));
});

app.get('/api/file', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const repoAlias = getRepoAliasFromRequest(request);
    const filePath = String(request.query.path ?? '');
    const content = await manager.readFile(repoAlias, filePath);
    response.json({ path: filePath, content });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.put('/api/file', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const { repoAlias, path: filePath, content } = request.body ?? {};

    if (
      typeof repoAlias !== 'string' ||
      typeof filePath !== 'string' ||
      typeof content !== 'string'
    ) {
      return response.status(400).json({
        error: 'Request body must include "repoAlias", "path", and "content" strings.',
      });
    }

    response.json({
      ok: true,
      status: await manager.writeFile(repoAlias, filePath, content),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/files', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const { repoAlias, path: filePath } = request.body ?? {};

    if (typeof repoAlias !== 'string' || typeof filePath !== 'string') {
      return response.status(400).json({
        error: 'Request body must include "repoAlias" and "path" strings.',
      });
    }

    response.status(201).json({
      ok: true,
      ...(await manager.createFile(repoAlias, filePath)),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/folders', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const { repoAlias, parentPath = '', name } = request.body ?? {};

    if (
      typeof repoAlias !== 'string' ||
      typeof parentPath !== 'string' ||
      typeof name !== 'string'
    ) {
      return response.status(400).json({
        error: 'Request body must include "repoAlias", "parentPath", and "name" strings.',
      });
    }

    response.status(201).json({
      ok: true,
      ...(await manager.createFolder(repoAlias, parentPath, name)),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.delete('/api/folders', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const { repoAlias, path: folderPath } = request.body ?? {};

    if (typeof repoAlias !== 'string' || typeof folderPath !== 'string') {
      return response.status(400).json({
        error: 'Request body must include "repoAlias" and "path" strings.',
      });
    }

    response.json({
      ok: true,
      ...(await manager.deleteFolder(repoAlias, folderPath)),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/refresh', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const repoAlias = getRepoAliasFromRequest(request);

    if (!repoAlias) {
      return response.status(400).json({ error: 'repoAlias is required.' });
    }

    response.json({
      ok: true,
      ...(await manager.refreshTree(repoAlias)),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/sync', async (request, response) => {
  const manager = requireRepoManager(response);

  if (!manager) {
    return;
  }

  try {
    const repoAlias = getRepoAliasFromRequest(request);

    if (!repoAlias) {
      return response.status(400).json({ error: 'repoAlias is required.' });
    }

    response.json({
      ok: true,
      ...(await manager.syncNow(repoAlias, 'manual')),
    });
  } catch (error) {
    sendError(response, error);
  }
});

await bootstrap();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`GitHub Note Sync server listening on http://0.0.0.0:${port}`);
});

async function shutdown() {
  if (syncTimer) {
    clearInterval(syncTimer);
  }

  if (repoManager) {
    await repoManager.dispose();
  }

  server.close();
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
