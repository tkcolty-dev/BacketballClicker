const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Parse DB creds from CF environment
let pool;
if (process.env.VCAP_SERVICES) {
  const vcap = JSON.parse(process.env.VCAP_SERVICES);
  const pgService = vcap['postgres'] || vcap['on-demand-postgres-db'] || vcap['postgresql'] || Object.values(vcap).find(s => s[0]?.credentials?.uri?.startsWith('postgres'));
  if (pgService) {
    const creds = pgService[0].credentials;
    pool = new Pool({ connectionString: creds.uri || creds.database_uri, ssl: false });
  }
} else if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
}

// Init DB
async function initDB() {
  if (!pool) { console.log('No database configured — leaderboard disabled'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      id SERIAL PRIMARY KEY,
      username VARCHAR(20) NOT NULL UNIQUE,
      best_score BIGINT DEFAULT 0,
      total_earned BIGINT DEFAULT 0,
      prestiges INT DEFAULT 0,
      clicks BIGINT DEFAULT 0,
      play_time INT DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Leaderboard table ready');
}
initDB().catch(e => console.error('DB init error:', e.message));

// Rate limit: 1 submit per 10s per IP
const submitTimes = new Map();

// Online players: username -> last ping timestamp
const onlinePlayers = new Map();

// POST /api/ping — heartbeat from active players
app.post('/api/ping', (req, res) => {
  const { username } = req.body;
  if (username && typeof username === 'string') onlinePlayers.set(username.trim().toLowerCase(), Date.now());
  const cutoff = Date.now() - 60000;
  let count = 0;
  for (const [, t] of onlinePlayers) if (t > cutoff) count++;
  res.json({ online: count });
});

// GET /api/online — current player count
app.get('/api/online', (req, res) => {
  const cutoff = Date.now() - 60000;
  let count = 0;
  for (const [, t] of onlinePlayers) if (t > cutoff) count++;
  res.json({ online: count });
});

// GET /api/leaderboard?limit=50
app.get('/api/leaderboard', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const { rows } = await pool.query(
      'SELECT username, best_score, total_earned, prestiges, clicks, play_time FROM leaderboard ORDER BY best_score DESC LIMIT $1',
      [limit]
    );
    res.json(rows);
  } catch (e) {
    console.error('Leaderboard fetch error:', e.message);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// GET /api/leaderboard/:username
app.get('/api/leaderboard/:username', async (req, res) => {
  if (!pool) return res.json(null);
  try {
    const username = req.params.username.toLowerCase();
    const { rows } = await pool.query(
      `SELECT username, best_score, total_earned, prestiges, clicks, play_time,
        (SELECT COUNT(*)+1 FROM leaderboard WHERE best_score > l.best_score) AS rank
       FROM leaderboard l WHERE username = $1`,
      [username]
    );
    res.json(rows[0] || null);
  } catch (e) {
    console.error('Player fetch error:', e.message);
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});

// POST /api/leaderboard
app.post('/api/leaderboard', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });

  // Rate limit
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const last = submitTimes.get(ip) || 0;
  if (now - last < 10000) return res.status(429).json({ error: 'Too fast — wait 10s' });
  submitTimes.set(ip, now);

  const { username, best_score, total_earned, prestiges, clicks, play_time } = req.body;

  // Validate username
  if (!username || typeof username !== 'string') return res.status(400).json({ error: 'Username required' });
  const clean = username.trim().toLowerCase();
  if (clean.length < 1 || clean.length > 20 || !/^[a-z0-9_]+$/.test(clean))
    return res.status(400).json({ error: 'Username: 1-20 chars, alphanumeric + underscore' });

  try {
    await pool.query(
      `INSERT INTO leaderboard (username, best_score, total_earned, prestiges, clicks, play_time, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (username) DO UPDATE SET
         best_score = GREATEST(leaderboard.best_score, EXCLUDED.best_score),
         total_earned = GREATEST(leaderboard.total_earned, EXCLUDED.total_earned),
         prestiges = GREATEST(leaderboard.prestiges, EXCLUDED.prestiges),
         clicks = GREATEST(leaderboard.clicks, EXCLUDED.clicks),
         play_time = GREATEST(leaderboard.play_time, EXCLUDED.play_time),
         updated_at = NOW()`,
      [clean, Math.floor(best_score || 0), Math.floor(total_earned || 0), Math.floor(prestiges || 0), Math.floor(clicks || 0), Math.floor(play_time || 0)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Submit error:', e.message);
    res.status(500).json({ error: 'Failed to submit score' });
  }
});

// DELETE /api/leaderboard/:username
app.delete('/api/leaderboard/:username', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    const username = req.params.username.toLowerCase();
    await pool.query('DELETE FROM leaderboard WHERE username = $1', [username]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete error:', e.message);
    res.status(500).json({ error: 'Failed to delete player' });
  }
});

// Clean up stale entries every 5 min
setInterval(() => {
  const rlCutoff = Date.now() - 15000;
  for (const [ip, t] of submitTimes) if (t < rlCutoff) submitTimes.delete(ip);
  const olCutoff = Date.now() - 60000;
  for (const [u, t] of onlinePlayers) if (t < olCutoff) onlinePlayers.delete(u);
}, 300000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Basketball Clicker running on port ${PORT}`));
