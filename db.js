const { DatabaseSync } = require('node:sqlite');

const DAY = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS myths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submitter_id TEXT NOT NULL,
  title TEXT NOT NULL,
  game TEXT NOT NULL,
  category TEXT NOT NULL,
  claim TEXT NOT NULL,
  test_method TEXT NOT NULL,
  evidence TEXT,
  credit_opt_in INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  staff_notes TEXT,
  test_result TEXT,
  result_note TEXT,
  video_url TEXT,
  review_message_id TEXT,
  public_message_id TEXT
);
CREATE TABLE IF NOT EXISTS votes (
  myth_id INTEGER NOT NULL,
  voter_id TEXT NOT NULL,
  PRIMARY KEY (myth_id, voter_id)
);
CREATE TABLE IF NOT EXISTS submissions (
  submitter_id TEXT NOT NULL,
  at INTEGER NOT NULL
);`;

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const SELECT = 'SELECT m.*, (SELECT COUNT(*) FROM votes v WHERE v.myth_id = m.id) AS votes FROM myths m';

  const setClause = (fields) => {
    const keys = Object.keys(fields);
    if (keys.some((k) => !/^[a-z_]+$/.test(k))) throw new Error('bad field name');
    return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => fields[k]) };
  };

  return {
    create(m, now = Date.now()) {
      const { lastInsertRowid } = q(`INSERT INTO myths
        (submitter_id, title, game, category, claim, test_method, evidence, credit_opt_in, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(m.submitter_id, m.title, m.game, m.category, m.claim, m.test_method, m.evidence ?? null, m.credit_opt_in ? 1 : 0, now, now);
      // Separate log so withdrawn submissions still count toward the daily limit.
      q('INSERT INTO submissions (submitter_id, at) VALUES (?, ?)').run(m.submitter_id, now);
      return this.get(Number(lastInsertRowid));
    },
    get: (id) => q(`${SELECT} WHERE m.id = ?`).get(id),
    update(id, fields) {
      const { sql, values } = setClause(fields);
      q(`UPDATE myths SET ${sql}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
    },
    // Atomic status change: only succeeds if the myth is currently in one of `from`.
    // Guards against two staff clicking the same button at once.
    transition(id, from, fields) {
      const { sql, values } = setClause(fields);
      const marks = from.map(() => '?').join(', ');
      return q(`UPDATE myths SET ${sql}, updated_at = ? WHERE id = ? AND status IN (${marks})`)
        .run(...values, Date.now(), id, ...from).changes === 1;
    },
    remove(id) {
      q('DELETE FROM votes WHERE myth_id = ?').run(id);
      q('DELETE FROM myths WHERE id = ?').run(id);
    },
    toggleVote(id, voter) {
      const added = q('INSERT OR IGNORE INTO votes (myth_id, voter_id) VALUES (?, ?)').run(id, voter).changes === 1;
      if (!added) q('DELETE FROM votes WHERE myth_id = ? AND voter_id = ?').run(id, voter);
      return { voted: added, count: this.get(id).votes };
    },
    recentCount: (user, now = Date.now()) =>
      q('SELECT COUNT(*) AS n FROM submissions WHERE submitter_id = ? AND at > ?').get(user, now - DAY).n,
    duplicateOf: (title) =>
      q(`SELECT id, title FROM myths WHERE lower(title) = lower(?) AND status NOT IN ('REJECTED', 'DUPLICATE')`).get(title),
    byUser: (user) => q(`${SELECT} WHERE m.submitter_id = ? ORDER BY m.id DESC`).all(user),
    byStatus: (...statuses) =>
      q(`${SELECT} WHERE m.status IN (${statuses.map(() => '?').join(', ')}) ORDER BY votes DESC, m.id`).all(...statuses),
    all: () => q(`${SELECT} ORDER BY m.id`).all(),
  };
}

// Neutralise mass/role/user pings and collapse whitespace.
function sanitize(text, max) {
  return String(text ?? '')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Like sanitize but keeps line breaks (for paragraph fields).
function sanitizeBlock(text, max) {
  return String(text ?? '')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<@[!&]?\d+>/g, '[mention]')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function validUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const fmtId = (id) => `MYTH-${String(id).padStart(4, '0')}`;

function parseId(raw) {
  const m = /^\s*(?:myth-)?0*(\d+)\s*$/i.exec(String(raw));
  return m ? Number(m[1]) : null;
}

const CSV_COLS = ['id', 'status', 'game', 'category', 'title', 'claim', 'test_method', 'evidence', 'votes',
  'submitter_id', 'credit_opt_in', 'staff_notes', 'test_result', 'result_note', 'video_url', 'created_at', 'updated_at'];

function toCsv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets running formulas
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fix = (r, c) => (c === 'id' ? fmtId(r.id) : /_at$/.test(c) ? new Date(r[c]).toISOString() : r[c]);
  return [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => cell(fix(r, c))).join(','))].join('\r\n');
}

module.exports = { openDb, sanitize, sanitizeBlock, validUrl, fmtId, parseId, toCsv };
