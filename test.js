// Self-check for db.js. Run: node test.js
const assert = require('node:assert/strict');
const { openDb, sanitize, validUrl, fmtId, parseId, toCsv } = require('./db');

const db = openDb();
const base = { game: 'GTA V', category: 'Myth / theory', claim: 'c', test_method: 't' };

// Create + IDs
const a = db.create({ ...base, submitter_id: 'u1', title: 'Bigfoot is real' });
assert.equal(a.id, 1);
assert.equal(a.status, 'PENDING');
assert.equal(fmtId(42), 'MYTH-0042');
assert.equal(parseId('MYTH-0042'), 42);
assert.equal(parseId('myth-7'), 7);
assert.equal(parseId('42'), 42);
assert.equal(parseId('abc'), null);

// Duplicate title (case-insensitive), ignored once rejected
assert.equal(db.duplicateOf('BIGFOOT IS REAL').id, 1);
assert.equal(db.duplicateOf('Something else'), undefined);

// Rate limit: 3 per 24h, withdrawals still count, old ones don't
const now = Date.now();
db.create({ ...base, submitter_id: 'u1', title: 'b' }, now);
const c = db.create({ ...base, submitter_id: 'u1', title: 'c' }, now);
db.remove(c.id);
assert.equal(db.recentCount('u1', now), 3);
assert.equal(db.recentCount('u1', now + 25 * 3600 * 1000), 0);
assert.equal(db.recentCount('u2', now), 0);

// Atomic transitions: second approve loses the race
assert.equal(db.transition(1, ['PENDING'], { status: 'APPROVED' }), true);
assert.equal(db.transition(1, ['PENDING'], { status: 'APPROVED' }), false);
assert.throws(() => db.update(1, { 'status = 1; --': 'x' }));

// Votes: toggle, one per user, repeated clicks idempotent
assert.deepEqual(db.toggleVote(1, 'v1'), { voted: true, count: 1 });
assert.deepEqual(db.toggleVote(1, 'v2'), { voted: true, count: 2 });
assert.deepEqual(db.toggleVote(1, 'v1'), { voted: false, count: 1 });
for (let i = 0; i < 10; i++) db.toggleVote(1, `voter${i}`);
assert.equal(db.get(1).votes, 11);
assert.equal(db.byStatus('APPROVED')[0].votes, 11);

// Rejected titles can be resubmitted
db.transition(2, ['PENDING'], { status: 'REJECTED' });
assert.equal(db.duplicateOf('b'), undefined);

// Sanitize + URLs
assert.equal(sanitize('hi @everyone <@&123> <@!456>  there', 100), 'hi @​everyone [mention] [mention] there');
assert.equal(sanitize('x'.repeat(200), 100).length, 100);
assert.equal(validUrl('https://youtu.be/abc'), 'https://youtu.be/abc');
assert.equal(validUrl('javascript:alert(1)'), null);
assert.equal(validUrl('not a url'), null);

// CSV escaping + formula guard
db.update(1, { result_note: 'said "hi", then\nleft', staff_notes: '=HYPERLINK("x")' });
const csv = toCsv(db.all());
assert.match(csv, /"said ""hi"", then\nleft"/);
assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
assert.match(csv, /^id,status,/);

console.log('All checks passed.');
