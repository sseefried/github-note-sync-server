import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const USER_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 64;
const PASSWORD_SCRYPT_PARAMS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};
const SESSION_SECRET_BYTES = 32;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_COOKIE_NAME = 'github_note_sync_session';

function createRequestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getSessionPath(config, sessionId) {
  return path.join(config.sessionsDir, `${sessionId}.json`);
}

function getUserPaths(config, userId) {
  const userDir = path.join(config.usersDir, userId);

  return {
    profilePath: path.join(userDir, 'profile.json'),
    reposDir: path.join(userDir, 'repos'),
    userDir,
  };
}

function normalizeUsername(username) {
  const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';

  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    throw createRequestError(
      400,
      'username must contain only letters, numbers, underscores, and hyphens.',
    );
  }

  return normalizedUsername;
}

function normalizePassword(password) {
  const normalizedPassword = typeof password === 'string' ? password : '';

  if (normalizedPassword.length < PASSWORD_MIN_LENGTH) {
    throw createRequestError(400, `password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  return normalizedPassword;
}

function parseCookieHeader(cookieHeader) {
  const parsedCookies = new Map();

  if (typeof cookieHeader !== 'string' || cookieHeader.trim() === '') {
    return parsedCookies;
  }

  for (const pair of cookieHeader.split(';')) {
    const trimmedPair = pair.trim();

    if (!trimmedPair) {
      continue;
    }

    const separatorIndex = trimmedPair.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedPair.slice(0, separatorIndex).trim();
    const value = trimmedPair.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    try {
      parsedCookies.set(key, decodeURIComponent(value));
    } catch {
      parsedCookies.set(key, value);
    }
  }

  return parsedCookies;
}

function hashSessionSecret(secret) {
  return createHash('sha256').update(secret).digest('base64url');
}

async function hashPassword(password) {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derivedKey = await scryptAsync(password, salt, PASSWORD_KEY_BYTES, PASSWORD_SCRYPT_PARAMS);

  return [
    'scrypt',
    String(PASSWORD_SCRYPT_PARAMS.N),
    String(PASSWORD_SCRYPT_PARAMS.r),
    String(PASSWORD_SCRYPT_PARAMS.p),
    salt.toString('base64url'),
    Buffer.from(derivedKey).toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, passwordHash) {
  const [algorithm, rawN, rawR, rawP, encodedSalt, encodedKey] = String(passwordHash).split('$');

  if (
    algorithm !== 'scrypt' ||
    !rawN ||
    !rawR ||
    !rawP ||
    !encodedSalt ||
    !encodedKey
  ) {
    return false;
  }

  const N = Number.parseInt(rawN, 10);
  const r = Number.parseInt(rawR, 10);
  const p = Number.parseInt(rawP, 10);

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, 'base64url');
  const expectedKey = Buffer.from(encodedKey, 'base64url');
  const actualKey = Buffer.from(
    await scryptAsync(password, salt, expectedKey.length, {
      N,
      r,
      p,
      maxmem: PASSWORD_SCRYPT_PARAMS.maxmem,
    }),
  );

  if (actualKey.length !== expectedKey.length) {
    return false;
  }

  return timingSafeEqual(actualKey, expectedKey);
}

export class AuthManager {
  constructor(config) {
    this.config = config;
  }

  async initialize() {
    await fs.mkdir(this.config.usersDir, { recursive: true });
    await fs.mkdir(this.config.sessionsDir, { recursive: true });
    await this.pruneExpiredSessions();
  }

  async getSessionStatus(request) {
    const userSession = await this.getUserSessionFromRequest(request);

    return {
      authenticated: userSession !== null,
      hasUsers: await this.hasUsers(),
      registrationOpen: await this.isRegistrationOpen(),
      user: userSession ? this.toPublicUser(userSession.user) : null,
    };
  }

  async hasUsers() {
    const users = await this.#listUserIds();
    return users.length > 0;
  }

  async isRegistrationOpen() {
    if (this.config.allowRegistration) {
      return true;
    }

    return !(await this.hasUsers());
  }

  async register(username, password, metadata = {}) {
    if (!(await this.isRegistrationOpen())) {
      throw createRequestError(403, 'Registration is currently disabled.');
    }

    const normalizedUsername = normalizeUsername(username);
    const normalizedPassword = normalizePassword(password);
    const existingUser = await this.findUserByUsername(normalizedUsername);

    if (existingUser) {
      throw createRequestError(409, `User "${normalizedUsername}" already exists.`);
    }

    const userId = randomUUID();
    const userPaths = getUserPaths(this.config, userId);
    const now = new Date().toISOString();
    const user = {
      createdAt: now,
      id: userId,
      passwordHash: await hashPassword(normalizedPassword),
      username: normalizedUsername,
    };

    await fs.mkdir(userPaths.reposDir, { recursive: true });
    await this.#writeJson(userPaths.profilePath, user);

    const { sessionToken } = await this.createSession(user, metadata);

    return {
      sessionToken,
      user: this.toPublicUser(user),
    };
  }

  async login(username, password, metadata = {}) {
    const normalizedUsername = normalizeUsername(username);
    const normalizedPassword = typeof password === 'string' ? password : '';
    const user = await this.findUserByUsername(normalizedUsername);

    if (!user) {
      throw createRequestError(401, 'Invalid username or password.');
    }

    const passwordMatches = await verifyPassword(normalizedPassword, user.passwordHash);

    if (!passwordMatches) {
      throw createRequestError(401, 'Invalid username or password.');
    }

    const { sessionToken } = await this.createSession(user, metadata);

    return {
      sessionToken,
      user: this.toPublicUser(user),
    };
  }

  async createSession(user, metadata = {}) {
    const sessionId = randomUUID();
    const sessionSecret = randomBytes(SESSION_SECRET_BYTES).toString('base64url');
    const now = new Date();
    const session = {
      clientType: typeof metadata.clientType === 'string' ? metadata.clientType : 'browser',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.sessionTtlMs).toISOString(),
      id: sessionId,
      ip: typeof metadata.ip === 'string' ? metadata.ip : null,
      lastSeenAt: now.toISOString(),
      secretHash: hashSessionSecret(sessionSecret),
      userAgent: typeof metadata.userAgent === 'string' ? metadata.userAgent : null,
      userId: user.id,
    };

    await this.#writeJson(getSessionPath(this.config, sessionId), session);

    return {
      session,
      sessionToken: `${sessionId}.${sessionSecret}`,
    };
  }

  async revokeSessionFromRequest(request) {
    const sessionToken = this.#extractSessionToken(request);

    if (!sessionToken) {
      return;
    }

    await this.revokeSessionToken(sessionToken);
  }

  async revokeSessionToken(sessionToken) {
    const parsedSession = this.#parseSessionToken(sessionToken);

    if (!parsedSession) {
      return;
    }

    const session = await this.#readSession(parsedSession.sessionId).catch(() => null);

    if (!session) {
      return;
    }

    if (session.revokedAt) {
      return;
    }

    session.revokedAt = new Date().toISOString();
    await this.#writeJson(getSessionPath(this.config, parsedSession.sessionId), session);
  }

  async getUserSessionFromRequest(request) {
    const sessionToken = this.#extractSessionToken(request);

    if (!sessionToken) {
      return null;
    }

    const parsedSession = this.#parseSessionToken(sessionToken);

    if (!parsedSession) {
      return null;
    }

    const session = await this.#readSession(parsedSession.sessionId).catch(() => null);

    if (!session) {
      return null;
    }

    if (session.revokedAt) {
      return null;
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await fs.rm(getSessionPath(this.config, session.id), { force: true }).catch(() => {});
      return null;
    }

    const expectedHash = Buffer.from(session.secretHash, 'base64url');
    const actualHash = Buffer.from(hashSessionSecret(parsedSession.secret), 'base64url');

    if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
      return null;
    }

    const user = await this.getUserById(session.userId).catch(() => null);

    if (!user) {
      return null;
    }

    await this.#touchSession(session);

    return {
      session,
      user,
    };
  }

  async getUserById(userId) {
    if (!USER_ID_PATTERN.test(String(userId))) {
      throw createRequestError(404, 'User does not exist.');
    }

    const rawProfile = await fs.readFile(getUserPaths(this.config, userId).profilePath, 'utf8');
    const profile = JSON.parse(rawProfile);

    if (
      typeof profile?.id !== 'string' ||
      typeof profile?.username !== 'string' ||
      typeof profile?.passwordHash !== 'string'
    ) {
      throw createRequestError(500, `User profile "${userId}" is invalid.`);
    }

    return profile;
  }

  async findUserByUsername(username) {
    const normalizedUsername = normalizeUsername(username);

    for (const userId of await this.#listUserIds()) {
      const user = await this.getUserById(userId).catch(() => null);

      if (user?.username === normalizedUsername) {
        return user;
      }
    }

    return null;
  }

  async pruneExpiredSessions() {
    const entries = await fs.readdir(this.config.sessionsDir, { withFileTypes: true }).catch(() => []);
    const now = Date.now();

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const sessionId = entry.name.replace(/\.json$/, '');
          const session = await this.#readSession(sessionId).catch(() => null);

          if (!session) {
            await fs.rm(getSessionPath(this.config, sessionId), { force: true }).catch(() => {});
            return;
          }

          const expiresAt = new Date(session.expiresAt).getTime();
          const revokedAt = session.revokedAt ? new Date(session.revokedAt).getTime() : 0;

          if (
            !Number.isFinite(expiresAt) ||
            expiresAt <= now ||
            (revokedAt && now - revokedAt >= SESSION_TOUCH_INTERVAL_MS)
          ) {
            await fs.rm(getSessionPath(this.config, sessionId), { force: true }).catch(() => {});
          }
        }),
    );
  }

  toPublicUser(user) {
    return {
      id: user.id,
      username: user.username,
    };
  }

  setSessionCookie(response, sessionToken) {
    response.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      maxAge: this.config.sessionTtlMs,
      path: '/',
      sameSite: this.config.sessionCookieSameSite,
      secure: this.config.sessionCookieSecure,
    });
  }

  clearSessionCookie(response) {
    response.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      path: '/',
      sameSite: this.config.sessionCookieSameSite,
      secure: this.config.sessionCookieSecure,
    });
  }

  #extractSessionToken(request) {
    const authorization = request.headers.authorization;

    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      return authorization.slice('Bearer '.length).trim();
    }

    return parseCookieHeader(request.headers.cookie).get(SESSION_COOKIE_NAME) ?? '';
  }

  #parseSessionToken(sessionToken) {
    if (typeof sessionToken !== 'string' || sessionToken.trim() === '') {
      return null;
    }

    const [sessionId, secret] = sessionToken.split('.');

    if (!SESSION_ID_PATTERN.test(String(sessionId)) || !secret) {
      return null;
    }

    return {
      secret,
      sessionId,
    };
  }

  async #readSession(sessionId) {
    const rawSession = await fs.readFile(getSessionPath(this.config, sessionId), 'utf8');
    const session = JSON.parse(rawSession);

    if (
      typeof session?.id !== 'string' ||
      typeof session?.userId !== 'string' ||
      typeof session?.secretHash !== 'string' ||
      typeof session?.expiresAt !== 'string'
    ) {
      throw createRequestError(500, `Session "${sessionId}" is invalid.`);
    }

    return session;
  }

  async #touchSession(session) {
    const lastSeenAt = new Date(session.lastSeenAt).getTime();
    const now = Date.now();

    if (Number.isFinite(lastSeenAt) && now - lastSeenAt < SESSION_TOUCH_INTERVAL_MS) {
      return;
    }

    const nextSession = {
      ...session,
      expiresAt: new Date(now + this.config.sessionTtlMs).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
    };

    await this.#writeJson(getSessionPath(this.config, session.id), nextSession);
  }

  async #listUserIds() {
    const entries = await fs.readdir(this.config.usersDir, { withFileTypes: true }).catch(() => []);

    return entries
      .filter((entry) => entry.isDirectory() && USER_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  async #writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

export { SESSION_COOKIE_NAME, createRequestError };
