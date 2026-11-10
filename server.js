require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { sql, connect } = require('./config/db');

const app = express();
let pool; // set once the database connection is ready (see "start" at the bottom)
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Behind a hosting proxy (Azure, Nginx, IIS...) the real visitor IP and
// protocol come from the proxy's headers. Needed for rate limiting and https links.
app.set('trust proxy', isProd ? 1 : false);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        // Lets the site work over plain http on localhost.
        'upgrade-insecure-requests': null,
      },
    },
  })
);

/* ----------------------------- helpers ----------------------------- */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 7;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
// Words that would clash with real routes or files.
const RESERVED = new Set(['api', 'health', 'admin', 'static', 'assets', 'favicon', 'robots', 'index']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// SQL Server error numbers for a duplicate value in a unique index / constraint.
const isDuplicate = (err) => err && (err.number === 2601 || err.number === 2627);

function randomCode(length = CODE_LENGTH) {
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** Validates the pasted link and returns a clean absolute http(s) URL. */
function normalizeUrl(input, req) {
  let raw = String(input || '').trim();
  if (!raw) throw new HttpError(400, 'Paste a link to shorten.');
  if (raw.length > 2048) throw new HttpError(400, 'That link is too long. The limit is 2,048 characters.');

  // Let people paste "example.com/page" without typing https://
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'That doesn\'t look like a valid link. Check it and try again.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'Only http:// and https:// links can be shortened.');
  }
  if (url.hostname !== 'localhost' && !url.hostname.includes('.')) {
    throw new HttpError(400, 'That link needs a full domain, like example.com.');
  }

  // Stop links that point back at LinkLite itself (would create redirect loops).
  const ownHosts = new Set([req.get('host')]);
  try {
    if (process.env.BASE_URL) ownHosts.add(new URL(process.env.BASE_URL).host);
  } catch {
    /* ignore a malformed BASE_URL here */
  }
  if (ownHosts.has(url.host)) {
    throw new HttpError(400, 'That link already points to LinkLite.');
  }

  const href = url.href;
  if (href.length > 2048) throw new HttpError(400, 'That link is too long. The limit is 2,048 characters.');
  return href;
}

function toDto(row, baseUrl) {
  return {
    id: String(row.id), // BIGINT comes back as a string from SQL Server
    shortCode: row.short_code,
    shortUrl: `${baseUrl}/${row.short_code}`,
    originalUrl: row.original_url,
    clicks: row.clicks,
    createdAt: row.created_at,
    lastClickedAt: row.last_clicked_at,
    ...(row.owner_email ? { ownerEmail: row.owner_email } : {}),
  };
}

/** Each browser sends a random ID so guest visitors only see their own links. */
function requireClient(req, res, next) {
  const id = req.get('x-client-id');
  if (!id || !CLIENT_ID_PATTERN.test(id)) {
    return next(new HttpError(400, 'Missing or invalid client ID. Reload the page and try again.'));
  }
  req.clientId = id.toLowerCase();
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return next(new HttpError(403, 'Administrator access is required.'));
  }
  next();
}

function userDto(user) {
  return {
    id: user.id,
    name: user.display_name,
    email: user.email,
    role: user.role,
    createdAt: user.created_at,
  };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new HttpError(400, 'Password must be at least 10 characters and no more than 72 bytes.');
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

class SqlSessionStore extends session.Store {
  get(sid, callback) {
    pool
      .request()
      .input('sid', sql.NVarChar(255), sid)
      .query('SELECT session_data FROM dbo.auth_sessions WHERE sid = @sid AND expires_at > SYSUTCDATETIME()')
      .then((result) => callback(null, result.recordset[0] ? JSON.parse(result.recordset[0].session_data) : null))
      .catch(callback);
  }

  set(sid, sessionData, callback) {
    const expires = sessionData.cookie && sessionData.cookie.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + SESSION_TTL);
    pool
      .request()
      .input('sid', sql.NVarChar(255), sid)
      .input('data', sql.NVarChar(sql.MAX), JSON.stringify(sessionData))
      .input('expires', sql.DateTime2, expires)
      .query(
        'MERGE dbo.auth_sessions WITH (HOLDLOCK) AS target ' +
          'USING (SELECT @sid AS sid) AS source ON target.sid = source.sid ' +
          'WHEN MATCHED THEN UPDATE SET session_data = @data, expires_at = @expires ' +
          'WHEN NOT MATCHED THEN INSERT (sid, session_data, expires_at) VALUES (@sid, @data, @expires);'
      )
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, sessionData, callback) {
    const expires = sessionData.cookie && sessionData.cookie.expires
      ? new Date(sessionData.cookie.expires)
      : new Date(Date.now() + SESSION_TTL);
    pool
      .request()
      .input('sid', sql.NVarChar(255), sid)
      .input('expires', sql.DateTime2, expires)
      .query('UPDATE dbo.auth_sessions SET expires_at = @expires WHERE sid = @sid')
      .then(() => callback(null))
      .catch(callback);
  }

  destroy(sid, callback) {
    pool
      .request()
      .input('sid', sql.NVarChar(255), sid)
      .query('DELETE FROM dbo.auth_sessions WHERE sid = @sid')
      .then(() => callback(null))
      .catch(callback);
  }
}

function regenerateSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.sessionVersion = user.session_version;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

async function provisionAdmin() {
  const email = process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !EMAIL_PATTERN.test(email) || !password) {
    throw new Error('Set both a valid ADMIN_EMAIL and ADMIN_PASSWORD to provision the administrator.');
  }
  validatePassword(password);

  const existing = await pool
    .request()
    .input('email', sql.NVarChar(254), email)
    .query('SELECT id, role FROM dbo.users WHERE email = @email');
  if (existing.recordset.length) {
    if (existing.recordset[0].role !== 'admin') {
      throw new Error('ADMIN_EMAIL already belongs to a standard user. Choose a separate admin email.');
    }
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  await pool
    .request()
    .input('id', sql.Char(36), crypto.randomUUID())
    .input('name', sql.NVarChar(80), 'Administrator')
    .input('email', sql.NVarChar(254), email)
    .input('hash', sql.VarChar(100), hash)
    .query(
      "INSERT INTO dbo.users (id, display_name, email, password_hash, role) VALUES (@id, @name, @email, @hash, 'admin')"
    );
  console.log(`Administrator account provisioned for ${email}.`);
}

const SESSION_SECRET = process.env.SESSION_SECRET;
app.use(
  session({
    name: 'linklite.sid',
    secret: SESSION_SECRET || 'startup-blocked-no-session-secret',
    store: new SqlSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: isProd,
      maxAge: SESSION_TTL,
    },
  })
);

app.use(
  asyncRoute(async (req, res, next) => {
    if (!req.session.userId) return next();
    const result = await pool
      .request()
      .input('id', sql.Char(36), req.session.userId)
      .query('SELECT id, display_name, email, role, is_active, session_version, created_at FROM dbo.users WHERE id = @id');
    const user = result.recordset[0];
    if (
      !user ||
      !user.is_active ||
      user.session_version !== req.session.sessionVersion
    ) {
      await new Promise((resolve, reject) => {
        req.session.destroy((err) => (err ? reject(err) : resolve()));
      });
      res.clearCookie('linklite.sid', { httpOnly: true, sameSite: 'strict', secure: isProd });
      return next();
    }
    req.user = user;
    next();
  })
);

/** Inserts a row and returns it (OUTPUT INSERTED.* hands back the new row in one step). */
async function insertUrl(ownerId, code, originalUrl) {
  const result = await pool
    .request()
    .input('owner', sql.Char(36), ownerId)
    .input('code', sql.VarChar(32), code)
    .input('url', sql.NVarChar(2048), originalUrl)
    .query(
      'INSERT INTO dbo.urls (owner_id, short_code, original_url) OUTPUT INSERTED.* VALUES (@owner, @code, @url)'
    );
  return result.recordset[0];
}

/* ----------------------------- middleware ----------------------------- */

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  try {
    await pool.request().query('SELECT 1 AS ok');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'database unavailable' });
  }
});

/* ----------------------------- API ----------------------------- */

const authApi = express.Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes.' },
});

authApi.use(express.json({ limit: '10kb' }), (req, res, next) => {
  req.body = req.body || {};
  next();
});
authApi.get('/me', (req, res) => res.json({ user: req.user ? userDto(req.user) : null }));

authApi.post(
  '/register',
  authLimiter,
  asyncRoute(async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body.password;
    if (!name || name.length > 80) throw new HttpError(400, 'Name must be between 1 and 80 characters.');
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    validatePassword(password);

    const user = {
      id: crypto.randomUUID(),
      display_name: name,
      email,
      role: 'user',
      is_active: true,
      session_version: 0,
      created_at: new Date(),
    };
    const hash = await bcrypt.hash(password, 12);
    try {
      await pool
        .request()
        .input('id', sql.Char(36), user.id)
        .input('name', sql.NVarChar(80), user.display_name)
        .input('email', sql.NVarChar(254), user.email)
        .input('hash', sql.VarChar(100), hash)
        .query(
          "INSERT INTO dbo.users (id, display_name, email, password_hash, role) VALUES (@id, @name, @email, @hash, 'user')"
        );
    } catch (err) {
      if (isDuplicate(err)) throw new HttpError(409, 'An account with that email already exists.');
      throw err;
    }

    await regenerateSession(req, user);
    res.status(201).json({ user: userDto(user) });
  })
);

let dummyPasswordHash;
authApi.post(
  '/login',
  authLimiter,
  asyncRoute(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || !password) throw new HttpError(400, 'Enter your email and password.');
    const result = await pool
      .request()
      .input('email', sql.NVarChar(254), email)
      .query('SELECT id, display_name, email, password_hash, role, is_active, session_version, created_at FROM dbo.users WHERE email = @email');
    const user = result.recordset[0];
    if (!dummyPasswordHash) dummyPasswordHash = await bcrypt.hash(crypto.randomUUID(), 10);
    const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : dummyPasswordHash);
    if (!user || !user.is_active || !passwordMatches) {
      throw new HttpError(401, 'Email or password is incorrect.');
    }

    await regenerateSession(req, user);
    res.json({ user: userDto(user) });
  })
);

authApi.post(
  '/logout',
  asyncRoute(async (req, res) => {
    if (req.session) {
      await new Promise((resolve, reject) => {
        req.session.destroy((err) => (err ? reject(err) : resolve()));
      });
    }
    res.clearCookie('linklite.sid', { httpOnly: true, sameSite: 'strict', secure: isProd });
    res.status(204).end();
  })
);

authApi.patch(
  '/profile',
  requireAuth,
  asyncRoute(async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!name || name.length > 80) throw new HttpError(400, 'Name must be between 1 and 80 characters.');
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    try {
      const result = await pool
        .request()
        .input('id', sql.Char(36), req.user.id)
        .input('name', sql.NVarChar(80), name)
        .input('email', sql.NVarChar(254), email)
        .query(
          'UPDATE dbo.users SET display_name = @name, email = @email OUTPUT INSERTED.id, INSERTED.display_name, INSERTED.email, INSERTED.role, INSERTED.created_at WHERE id = @id'
        );
      res.json({ user: userDto(result.recordset[0]) });
    } catch (err) {
      if (isDuplicate(err)) throw new HttpError(409, 'An account with that email already exists.');
      throw err;
    }
  })
);

authApi.post(
  '/password',
  requireAuth,
  asyncRoute(async (req, res) => {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = req.body.newPassword;
    validatePassword(newPassword);
    const result = await pool
      .request()
      .input('id', sql.Char(36), req.user.id)
      .query('SELECT password_hash FROM dbo.users WHERE id = @id');
    if (!currentPassword || !(await bcrypt.compare(currentPassword, result.recordset[0].password_hash))) {
      throw new HttpError(401, 'Current password is incorrect.');
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await pool
      .request()
      .input('id', sql.Char(36), req.user.id)
      .input('hash', sql.VarChar(100), hash)
      .query('UPDATE dbo.users SET password_hash = @hash, session_version = session_version + 1 WHERE id = @id');
    await new Promise((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()));
    });
    res.clearCookie('linklite.sid', { httpOnly: true, sameSite: 'strict', secure: isProd });
    res.status(204).end();
  })
);

app.use('/api/auth', authApi);

const adminApi = express.Router();
adminApi.use(express.json({ limit: '10kb' }), requireAuth, requireAdmin);

adminApi.get(
  '/summary',
  asyncRoute(async (req, res) => {
    const result = await pool.request().query(
      'SELECT (SELECT COUNT_BIG(*) FROM dbo.users WHERE role = \'user\') AS users, ' +
        '(SELECT COUNT_BIG(*) FROM dbo.urls) AS links, ' +
        '(SELECT COALESCE(SUM(CONVERT(BIGINT, clicks)), 0) FROM dbo.urls) AS clicks'
    );
    res.json(result.recordset[0]);
  })
);

adminApi.get(
  '/users',
  asyncRoute(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const request = pool.request();
    let where = '';
    if (search) {
      where = 'WHERE display_name LIKE @search OR email LIKE @search';
      request.input('search', sql.NVarChar(202), `%${search}%`);
    }
    const result = await request.query(
      `SELECT TOP (200) id, display_name, email, role, is_active, created_at FROM dbo.users ${where} ORDER BY created_at DESC`
    );
    res.json(result.recordset);
  })
);

adminApi.patch(
  '/users/:id/status',
  asyncRoute(async (req, res) => {
    if (!CLIENT_ID_PATTERN.test(req.params.id)) throw new HttpError(400, 'Invalid user ID.');
    if (req.params.id === req.user.id) throw new HttpError(400, 'You cannot change your own account status.');
    if (typeof req.body.isActive !== 'boolean') throw new HttpError(400, 'Choose whether the account should be active.');
    const result = await pool
      .request()
      .input('id', sql.Char(36), req.params.id)
      .input('active', sql.Bit, req.body.isActive)
      .query(
        "UPDATE dbo.users SET is_active = @active, session_version = session_version + 1 OUTPUT INSERTED.id, INSERTED.is_active WHERE id = @id AND role = 'user'"
      );
    if (!result.recordset.length) throw new HttpError(404, 'Standard user not found.');
    res.json({ id: result.recordset[0].id, isActive: result.recordset[0].is_active });
  })
);

adminApi.get(
  '/links',
  asyncRoute(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const request = pool.request();
    let where = '';
    if (search) {
      where = 'WHERE u.short_code LIKE @search OR u.original_url LIKE @search OR users.email LIKE @search';
      request.input('search', sql.NVarChar(202), `%${search}%`);
    }
    const result = await request.query(
      `SELECT TOP (200) u.*, users.email AS owner_email FROM dbo.urls AS u LEFT JOIN dbo.users AS users ON users.id = u.owner_id ${where} ORDER BY u.created_at DESC`
    );
    res.json(result.recordset.map((row) => toDto(row, getBaseUrl(req))));
  })
);

adminApi.delete(
  '/links/:id',
  asyncRoute(async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(400, 'Invalid link ID.');
    const result = await pool.request().input('id', sql.BigInt, req.params.id).query('DELETE FROM dbo.urls WHERE id = @id');
    if (result.rowsAffected[0] === 0) throw new HttpError(404, 'Link not found.');
    res.status(204).end();
  })
);

app.use('/api/admin', adminApi);

const api = express.Router();
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a minute and try again.' },
});
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You\'re creating links too quickly. Wait a minute and try again.' },
});

api.use(apiLimiter, express.json({ limit: '10kb' }), requireClient);

api.get('/urls/summary', async (req, res, next) => {
  try {
    const owner = req.user ? req.user.id : req.clientId;
    const result = await pool
      .request()
      .input('owner', sql.Char(36), owner)
      .query(
        'SELECT COUNT_BIG(*) AS links, COALESCE(SUM(CONVERT(BIGINT, clicks)), 0) AS clicks ' +
          'FROM dbo.urls WHERE owner_id = @owner'
      );
    res.json(result.recordset[0]);
  } catch (err) {
    next(err);
  }
});

// Create a short link
api.post('/urls', createLimiter, async (req, res, next) => {
  try {
    const owner = req.user ? req.user.id : req.clientId;
    const originalUrl = normalizeUrl(req.body && req.body.url, req);
    const alias = req.body && typeof req.body.alias === 'string' ? req.body.alias.trim() : '';

    let row = null;

    if (alias) {
      if (!ALIAS_PATTERN.test(alias)) {
        throw new HttpError(400, 'Custom endings use 3 to 32 letters, numbers, hyphens or underscores.');
      }
      if (RESERVED.has(alias.toLowerCase())) {
        throw new HttpError(400, 'That custom ending is reserved. Choose another.');
      }
      try {
        row = await insertUrl(owner, alias, originalUrl);
      } catch (err) {
        if (isDuplicate(err)) throw new HttpError(409, 'That custom ending is taken. Try another.');
        throw err;
      }
    } else {
      // Random codes can (rarely) collide, so retry a few times.
      for (let attempt = 0; attempt < 5 && !row; attempt++) {
        try {
          row = await insertUrl(owner, randomCode(), originalUrl);
        } catch (err) {
          if (!isDuplicate(err)) throw err;
        }
      }
      if (!row) throw new HttpError(500, 'Could not generate a unique link. Try again.');
    }

    res.status(201).json(toDto(row, getBaseUrl(req)));
  } catch (err) {
    next(err);
  }
});

// List this browser's links (newest first)
api.get('/urls', async (req, res, next) => {
  try {
    const owner = req.user ? req.user.id : req.clientId;
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const request = pool.request().input('owner', sql.Char(36), owner);
    let searchClause = '';
    if (search) {
      request.input('search', sql.NVarChar(202), `%${search}%`);
      searchClause = ' AND (short_code LIKE @search OR original_url LIKE @search)';
    }
    const result = await request.query(
      `SELECT TOP (200) * FROM dbo.urls WHERE owner_id = @owner${searchClause} ORDER BY created_at DESC, id DESC`
    );
    const base = getBaseUrl(req);
    res.json(result.recordset.map((row) => toDto(row, base)));
  } catch (err) {
    next(err);
  }
});

// Delete one of this browser's links
api.delete('/urls/:id', async (req, res, next) => {
  try {
    const owner = req.user ? req.user.id : req.clientId;
    if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(400, 'Invalid link ID.');
    const result = await pool
      .request()
      .input('id', sql.BigInt, req.params.id)
      .input('owner', sql.Char(36), owner)
      .query('DELETE FROM dbo.urls WHERE id = @id AND owner_id = @owner');
    if (result.rowsAffected[0] === 0) throw new HttpError(404, 'Link not found. It may already be deleted.');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use('/api', api);

/* ----------------------------- redirect ----------------------------- */

// GET /abc1234 -> 302 to the original URL, and count the click.
app.get('/:code([A-Za-z0-9_-]{3,32})', async (req, res, next) => {
  try {
    const found = await pool
      .request()
      .input('code', sql.VarChar(32), req.params.code)
      .query('SELECT TOP (1) id, original_url FROM dbo.urls WHERE short_code = @code');
    if (found.recordset.length === 0) return next();
    const row = found.recordset[0];

    // Fire-and-forget so the visitor isn't kept waiting on the counter.
    pool
      .request()
      .input('id', sql.BigInt, row.id)
      .query('UPDATE dbo.urls SET clicks = clicks + 1, last_clicked_at = SYSUTCDATETIME() WHERE id = @id')
      .catch((err) => console.error('Click count failed:', err.message));

    // 302 (not 301) so browsers don't cache the redirect and every click is counted.
    res.set('Cache-Control', 'no-store');
    res.redirect(302, row.original_url);
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- errors ----------------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Request body must be valid JSON.');
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 ? 'Something went wrong on our side. Try again.' : err.message;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

/* ----------------------------- start ----------------------------- */

(async () => {
  if (!SESSION_SECRET || SESSION_SECRET.length < 32 || SESSION_SECRET.startsWith('replace_')) {
    console.error('Set SESSION_SECRET in your .env file to a random value of at least 32 characters.');
    process.exit(1);
  }

  try {
    pool = await connect();
  } catch (err) {
    console.error('Cannot connect to SQL Server:', err.message);
    console.error('1) Is SQL Server running?  2) Is TCP/IP enabled?  3) Are the DB_* values in .env correct?');
    console.error('4) Did you run database/schema.sql in SSMS (or npm run db:init)?');
    process.exit(1);
  }

  try {
    const schema = await pool
      .request()
      .query("SELECT OBJECT_ID(N'dbo.users', N'U') AS usersTable, OBJECT_ID(N'dbo.auth_sessions', N'U') AS sessionsTable");
    if (!schema.recordset[0].usersTable || !schema.recordset[0].sessionsTable) {
      throw new Error('Authentication tables are missing. Run database/schema.sql in SSMS or npm run db:init.');
    }
    await provisionAdmin();
  } catch (err) {
    console.error('Could not initialize authentication:', err.message);
    await pool.close();
    process.exit(1);
  }

  const sessionCleanup = setInterval(() => {
    pool
      .request()
      .query('DELETE FROM dbo.auth_sessions WHERE expires_at <= SYSUTCDATETIME()')
      .catch((err) => console.error('Session cleanup failed:', err.message));
  }, 60 * 60 * 1000);
  sessionCleanup.unref();

  app.listen(PORT, () => {
    console.log(`LinkLite is running on port ${PORT}`);
    console.log(`Open ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  });
})();
