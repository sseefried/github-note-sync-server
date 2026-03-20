import cors from 'cors';
import express from 'express';
import { AuthManager } from './auth-manager.js';
import { loadConfig } from './config.js';
import { RepoManager } from './repo-manager.js';

const app = express();

app.use(express.json({ limit: '10mb' }));

let authManager = null;
let repoManager = null;
let startupError = null;
let syncTimer = null;
let sessionPruneTimer = null;
let serverConfig = null;

function isPrivateIpv4Address(hostname) {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function isAllowedOrigin(origin, config) {
  if (typeof origin !== 'string' || origin.trim() === '') {
    return true;
  }

  if (config.allowedOrigins.includes(origin)) {
    return true;
  }

  try {
    const parsedOrigin = new URL(origin);
    const hostname = parsedOrigin.hostname.toLowerCase();

    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      isPrivateIpv4Address(hostname) ||
      hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}

function getForwardedProto(request) {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const firstValue = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;

  return String(firstValue ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
}

app.use((request, response, next) => {
  if (!serverConfig) {
    next();
    return;
  }

  if (getForwardedProto(request) !== 'https') {
    response.status(400).json({
      error:
        'HTTPS is required. Send requests through the configured reverse proxy so it can forward X-Forwarded-Proto: https.',
    });
    return;
  }

  next();
});

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!serverConfig) {
        callback(null, false);
        return;
      }

      callback(null, isAllowedOrigin(origin, serverConfig));
    },
  }),
);

function sendError(response, error, fallbackStatus = 500) {
  response.status(error?.statusCode ?? fallbackStatus).json({ error: error.message });
}

async function bootstrap() {
  try {
    const config = await loadConfig();
    const nextAuthManager = new AuthManager(config);
    const nextRepoManager = new RepoManager(config);

    await nextAuthManager.initialize();
    await nextRepoManager.initialize();

    serverConfig = config;
    authManager = nextAuthManager;
    repoManager = nextRepoManager;
    startupError = null;

    syncTimer = setInterval(() => {
      repoManager.syncActiveRepos().catch((error) => {
        console.error(error);
      });
    }, config.syncIntervalMs);

    sessionPruneTimer = setInterval(() => {
      authManager.pruneExpiredSessions().catch((error) => {
        console.error(error);
      });
    }, 60 * 60 * 1000);
  } catch (error) {
    startupError = error;
    console.error(error);
  }
}

function requireService(service, response) {
  if (!service) {
    response.status(503).json({
      error:
        startupError?.message ??
        'Repository service is not available. Check the server logs and restart the server.',
    });
    return null;
  }

  return service;
}

async function requireAuthenticatedUser(request, response) {
  const auth = requireService(authManager, response);

  if (!auth) {
    return null;
  }

  const userSession = await auth.getUserSessionFromRequest(request);

  if (!userSession) {
    auth.clearSessionCookie(response);
    response.status(401).json({ error: 'Authentication required.' });
    return null;
  }

  return userSession.user;
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

function wantsTokenSession(request) {
  return String(request.headers['x-session-transport'] ?? '').trim().toLowerCase() === 'token';
}

function getClientMetadata(request) {
  return {
    clientType: wantsTokenSession(request) || request.headers.authorization ? 'token' : 'browser',
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function applySessionResponse(request, response, auth, result, extras = {}) {
  const payload = {
    authenticated: true,
    user: result.user,
    ...extras,
  };

  if (wantsTokenSession(request)) {
    payload.sessionToken = result.sessionToken;
  } else {
    auth.setSessionCookie(response, result.sessionToken);
  }

  response.json(payload);
}

app.get('/api/auth/session', async (request, response) => {
  const auth = requireService(authManager, response);

  if (!auth) {
    return;
  }

  try {
    response.json(await auth.getSessionStatus(request));
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/api/auth/register', async (request, response) => {
  const auth = requireService(authManager, response);

  if (!auth) {
    return;
  }

  try {
    const { username, password } = request.body ?? {};
    const result = await auth.register(username, password, getClientMetadata(request));

    response.status(201);
    applySessionResponse(request, response, auth, result);
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/auth/login', async (request, response) => {
  const auth = requireService(authManager, response);

  if (!auth) {
    return;
  }

  try {
    const { username, password } = request.body ?? {};
    const result = await auth.login(username, password, getClientMetadata(request));
    applySessionResponse(request, response, auth, result);
  } catch (error) {
    sendError(response, error, 401);
  }
});

app.post('/api/auth/logout', async (request, response) => {
  const auth = requireService(authManager, response);

  if (!auth) {
    return;
  }

  try {
    await auth.revokeSessionFromRequest(request);
    auth.clearSessionCookie(response);
    response.json({ ok: true });
  } catch (error) {
    sendError(response, error);
  }
});

app.get('/api/repos', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    response.json({
      repoAliases: await manager.listRepoAliases(user.id),
    });
  } catch (error) {
    sendError(response, error);
  }
});

app.post('/api/repos', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    const { repoAlias, repo } = request.body ?? {};

    if (typeof repoAlias !== 'string' || typeof repo !== 'string') {
      return response
        .status(400)
        .json({ error: 'Request body must include "repoAlias" and "repo" strings.' });
    }

    const result = await manager.createRepoAlias(user.id, repoAlias, repo);
    response.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.get('/api/repos/:repoAlias/public-key', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    response.json({
      publicKey: await manager.getPublicKey(user.id, request.params.repoAlias),
      repoAlias: request.params.repoAlias,
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.get('/api/repos/:repoAlias', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    response.json(await manager.getRepoAliasDetails(user.id, request.params.repoAlias));
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.put('/api/repos/:repoAlias', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    const { repo } = request.body ?? {};

    if (typeof repo !== 'string') {
      return response.status(400).json({ error: 'Request body must include a "repo" string.' });
    }

    response.json(await manager.updateRepoAlias(user.id, request.params.repoAlias, repo));
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.delete('/api/repos/:repoAlias', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    response.json(await manager.deleteRepoAlias(user.id, request.params.repoAlias));
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.get('/api/bootstrap', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  const repoAlias = getRepoAliasFromRequest(request);

  if (!repoAlias) {
    return response.status(400).json({ error: 'repoAlias is required.' });
  }

  return response.json(await manager.getState(user.id, repoAlias));
});

app.get('/api/file', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    const repoAlias = getRepoAliasFromRequest(request);
    const filePath = String(request.query.path ?? '');
    response.json(await manager.readFile(user.id, repoAlias, filePath));
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/ops', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    const { repoAlias, ops } = request.body ?? {};

    if (typeof repoAlias !== 'string' || !Array.isArray(ops)) {
      return response.status(400).json({
        error: 'Request body must include a "repoAlias" string and an "ops" array.',
      });
    }

    if (ops.length !== 1) {
      return response.status(400).json({
        error: 'This server currently accepts exactly one op per /api/ops request.',
      });
    }

    response.json({
      ok: true,
      ...(await manager.applyOps(user.id, repoAlias, ops)),
    });
  } catch (error) {
    if (error?.statusCode === 409 && error?.payload) {
      response.status(409).json(error.payload);
      return;
    }

    sendError(response, error, 400);
  }
});

app.post('/api/conflicts/commit-markers', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    const {
      repoAlias,
      path: filePath,
      baseContent,
      localContent,
    } = request.body ?? {};

    if (
      typeof repoAlias !== 'string' ||
      typeof filePath !== 'string' ||
      typeof baseContent !== 'string' ||
      typeof localContent !== 'string'
    ) {
      return response.status(400).json({
        error:
          'Request body must include "repoAlias", "path", "baseContent", and "localContent" strings.',
      });
    }

    response.json({
      ok: true,
      ...(await manager.commitConflictMarkers(user.id, repoAlias, {
        baseContent,
        localContent,
        path: filePath,
      })),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.put('/api/file', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
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
      status: await manager.writeFile(user.id, repoAlias, filePath, content),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/files', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
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
      ...(await manager.createFile(user.id, repoAlias, filePath)),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/folders', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
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
      ...(await manager.createFolder(user.id, repoAlias, parentPath, name)),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.delete('/api/folders', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
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
      ...(await manager.deleteFolder(user.id, repoAlias, folderPath)),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/refresh', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    const repoAlias = getRepoAliasFromRequest(request);

    if (!repoAlias) {
      return response.status(400).json({ error: 'repoAlias is required.' });
    }

    response.json({
      ok: true,
      ...(await manager.refreshTree(user.id, repoAlias)),
    });
  } catch (error) {
    sendError(response, error, 400);
  }
});

app.post('/api/sync', async (request, response) => {
  const manager = requireService(repoManager, response);
  const user = await requireAuthenticatedUser(request, response);

  if (!manager || !user) {
    return;
  }

  try {
    const repoAlias = getRepoAliasFromRequest(request);

    if (!repoAlias) {
      return response.status(400).json({ error: 'repoAlias is required.' });
    }

    response.json({
      ok: true,
      ...(await manager.syncNow(user.id, repoAlias, 'manual')),
    });
  } catch (error) {
    sendError(response, error);
  }
});

await bootstrap();

const listenPort = serverConfig?.port ?? 3001;
const server = app.listen(listenPort, '0.0.0.0', () => {
  console.log(`GitHub Note Sync server listening on http://0.0.0.0:${listenPort}`);
});

async function shutdown() {
  if (syncTimer) {
    clearInterval(syncTimer);
  }

  if (sessionPruneTimer) {
    clearInterval(sessionPruneTimer);
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
