require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  SESSION_SECRET,
  BASE_URL = 'http://localhost:3000',
  PORT = 3000,
} = process.env;

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !SESSION_SECRET) {
  console.error('Missing GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET or SESSION_SECRET. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const isHttps = BASE_URL.startsWith('https://');
const app = express();
if (isHttps) app.set('trust proxy', 1);

app.use(express.json());
app.use(
  session({
    name: 'rm.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,       // JS in the browser can never read the session
      sameSite: 'lax',
      secure: isHttps,
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// The GitHub token lives only in the server-side session, never in the browser.
async function gh(token, method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'repo-manager',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

// GitHub's 422 responses say only "Validation Failed" in `message`; the real reason is in `errors`.
function ghError(r, fallback) {
  const d = r.data || {};
  const details = Array.isArray(d.errors)
    ? d.errors.map((e) => (typeof e === 'string' ? e : e.message || e.code)).filter(Boolean).join('; ')
    : '';
  const msg = [d.message, details].filter(Boolean).join(': ');
  return msg || fallback;
}

function requireAuth(req, res, next) {
  if (!req.session.token) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// Mutating routes must carry a custom header. Browsers won't let other sites
// send this cross-origin without a CORS preflight (which we never allow), so
// this blocks CSRF.
function requireFetchHeader(req, res, next) {
  if (req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ error: 'Missing request header' });
  }
  next();
}

const NAME = /^[A-Za-z0-9_.-]+$/;
function validRepoParams(req, res, next) {
  const { owner, repo } = req.params;
  if (!NAME.test(owner) || !NAME.test(repo)) {
    return res.status(400).json({ error: 'Invalid repository name' });
  }
  next();
}

// ---------- Auth ----------
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/callback`,
    // repo: read repos and change visibility. delete_repo: delete repos.
    scope: 'repo delete_repo',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send('Sign-in failed: invalid state. Please try again.');
  }
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/auth/callback`,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).send('Sign-in failed: GitHub did not return a token.');
    }
    // New session ID after login prevents session fixation.
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Session error');
      req.session.token = tokenData.access_token;
      req.session.save(() => res.redirect('/'));
    });
  } catch (e) {
    res.status(500).send('Sign-in failed. Please try again.');
  }
});

app.post('/auth/logout', requireFetchHeader, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('rm.sid');
    res.status(204).end();
  });
});

// ---------- API ----------
app.get('/api/me', requireAuth, async (req, res) => {
  const r = await gh(req.session.token, 'GET', '/user');
  if (r.status === 401) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'GitHub session expired' });
  }
  if (!r.ok) return res.status(502).json({ error: 'Could not load your GitHub profile' });
  const { login, name, avatar_url, html_url } = r.data;
  res.json({ login, name, avatar_url, html_url });
});

app.get('/api/repos', requireAuth, async (req, res) => {
  const all = [];
  for (let page = 1; page <= 10; page++) { // up to 1000 repos
    const r = await gh(
      req.session.token,
      'GET',
      `/user/repos?affiliation=owner,organization_member&sort=updated&per_page=100&page=${page}`
    );
    if (!r.ok) {
      return res.status(r.status === 401 ? 401 : 502).json({ error: 'Could not load repositories' });
    }
    all.push(...r.data);
    if (r.data.length < 100) break;
  }
  // Only repos the user can actually administer (needed to change visibility or delete)
  const repos = all
    .filter((x) => x.permissions && x.permissions.admin)
    .map((x) => ({
      id: x.id,
      name: x.name,
      full_name: x.full_name,
      owner: x.owner.login,
      private: x.private,
      fork: x.fork,
      archived: x.archived,
      description: x.description,
      html_url: x.html_url,
      updated_at: x.updated_at,
    }));
  res.json(repos);
});

app.patch('/api/repos/:owner/:repo/visibility', requireAuth, requireFetchHeader, validRepoParams, async (req, res) => {
  if (typeof req.body.private !== 'boolean') {
    return res.status(400).json({ error: '"private" must be true or false' });
  }
  const { owner, repo } = req.params;
  const r = await gh(req.session.token, 'PATCH', `/repos/${owner}/${repo}`, { private: req.body.private });
  if (!r.ok) {
    return res.status(r.status).json({ error: ghError(r, 'GitHub rejected the change') });
  }
  res.json({ full_name: r.data.full_name, private: r.data.private });
});

app.delete('/api/repos/:owner/:repo', requireAuth, requireFetchHeader, validRepoParams, async (req, res) => {
  const { owner, repo } = req.params;
  // The server re-checks the typed confirmation, so the safety step can't be skipped from the client.
  if (req.body.confirm !== `${owner}/${repo}`) {
    return res.status(400).json({ error: 'Confirmation text does not match the repository name' });
  }
  const r = await gh(req.session.token, 'DELETE', `/repos/${owner}/${repo}`);
  if (!r.ok) {
    return res.status(r.status).json({ error: ghError(r, 'GitHub could not delete the repository') });
  }
  res.status(204).end();
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Repo Manager running at ${BASE_URL}`));
