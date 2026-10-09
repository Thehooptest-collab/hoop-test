// The Hoop Test: anonymous score endpoint (Vercel serverless function).
//
//   POST /api/scores  { p: puzzleNumber, id: anonymousId, won: true|false, hints: 1-8 }
//   GET  /api/scores?p=puzzleNumber  ->  { p, dist: { "1": n, ..., "8": n, "L": n } }
//
// Stores only counts per puzzle (how many players solved it in N hints, or missed it)
// plus a set of anonymous IDs so one browser can't be counted twice. No names, no
// emails, no accounts. Uses an Upstash Redis database over its REST API.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Puzzle #1 was Wednesday, October 7, 2026. Keep in sync with the game.
const EPOCH_DAY = Math.floor(Date.UTC(2026, 9, 7) / 86400000);
const IDS_TTL_SECONDS = 60 * 24 * 3600; // dedupe memory only needs to last a couple of months

function puzzleNumberAt(ms) {
  return Math.floor(ms / 86400000) - EPOCH_DAY + 1;
}

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Players in any timezone can be on different calendar days, so accept the
// window of puzzle numbers that are "today" somewhere on Earth (UTC-12 to UTC+14).
function acceptablePuzzleRange(now) {
  return { min: Math.max(1, puzzleNumberAt(now - 12 * 3600000)), max: puzzleNumberAt(now + 14 * 3600000) };
}

function parsePuzzle(value, now) {
  const p = Number(value);
  const { max } = acceptablePuzzleRange(now);
  return Number.isInteger(p) && p >= 1 && p <= max ? p : null;
}

async function handler(req, res, now = Date.now()) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: 'database not configured' });
  }

  try {
    if (req.method === 'GET') {
      const p = parsePuzzle(req.query && req.query.p, now);
      if (!p) return res.status(400).json({ error: 'bad puzzle number' });
      const flat = (await redis(['HGETALL', 'hoop:p:' + p + ':dist'])) || [];
      const dist = {};
      for (let i = 0; i < flat.length; i += 2) dist[flat[i]] = parseInt(flat[i + 1], 10) || 0;
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
      return res.status(200).json({ p, dist });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { min, max } = acceptablePuzzleRange(now);
      const p = Number(body.p);
      const hints = Number(body.hints);
      const won = body.won === true;
      const idOk = typeof body.id === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(body.id);
      const pOk = Number.isInteger(p) && p >= min && p <= max;
      const hintsOk = !won || (Number.isInteger(hints) && hints >= 1 && hints <= 8);
      if (!idOk || !pOk || !hintsOk) return res.status(400).json({ error: 'invalid submission' });

      const idsKey = 'hoop:p:' + p + ':ids';
      const isNew = await redis(['SADD', idsKey, body.id]);
      if (isNew === 1) {
        await redis(['HINCRBY', 'hoop:p:' + p + ':dist', won ? String(hints) : 'L', 1]);
        await redis(['EXPIRE', idsKey, IDS_TTL_SECONDS]);
      }
      return res.status(200).json({ ok: true, counted: isNew === 1 });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
}

module.exports = handler;
module.exports.puzzleNumberAt = puzzleNumberAt;
