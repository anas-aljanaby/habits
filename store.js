// Persistence boundary. The UI only calls the functions exported here, and each
// record type maps to a future Supabase table:
//
//   items  { id, title, counts, position, createdOn, deletedOn }
//   days   { date, required: [itemId], done: [itemId] }
//   plan   { text, updatedAt }                  (single row) the daily structure, "how my day goes"
//   notes  { id, body, updatedAt }
//   tasks  { id, date, title, done, position }   one-off to-dos for a day, apart from habits
//   dayNotes    { date, body, updatedAt }        free text for a day, under its tasks
//   goals       { id, title, deadline, createdOn, archivedOn, outcome }   outcome: null | 'done' | 'dropped'
//   checkpoints { id, goalId, date, title, notes, doneOn }                a check-in along a goal
//
// Dates are local 'YYYY-MM-DD' strings.
//
// The whole db is kept in localStorage as a cache and backed up as one JSON file
// in a private GitHub repo, so it survives the Home Screen app being deleted
// (iOS wipes its storage with it). Saves push to the repo shortly after; launch
// pulls from it. Single user: the last device to write wins.

const KEY = 'tally.v1';
const LEGACY_KEY = 'habits.v1'; // first version of this app, same origin
const TOKEN_KEY = 'tally.token';
const SYNC_KEY = 'tally.sync';  // { sha, dirty }: last known remote version, unpushed edits
const FILE_URL = 'https://api.github.com/repos/anas-aljanaby/tally-data/contents/tally.json';

let db = read();
let sync = readSync();

function read() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    if (data && Array.isArray(data.items)) return withDefaults(data);
  } catch {}
  return withDefaults(migrateLegacy() || { items: [], days: {}, plan: { text: '', updatedAt: null }, notes: [] });
}

// Fills in record types added after a copy was saved, locally or in the backup.
function withDefaults(data) {
  return { tasks: [], dayNotes: {}, goals: [], checkpoints: [], ...data };
}

// One-time import of the earlier version's data so the streak and history carry over.
function migrateLegacy() {
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (!old || !Array.isArray(old.items)) return null;
    const oldDays = old.days || {};
    const firstDay = Object.keys(oldDays).sort()[0] || '1970-01-01';
    const days = {};
    for (const [date, d] of Object.entries(oldDays)) {
      days[date] = { date, required: d.req || [], done: d.done || [] };
    }
    return {
      items: old.items.map((it, i) => ({
        id: it.id, title: it.title, counts: !!it.streak, position: i, createdOn: firstDay, deletedOn: null,
      })),
      days,
      plan: { text: old.notes || '', updatedAt: null },
      notes: [],
    };
  } catch {
    return null;
  }
}

function readSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || { sha: null, dirty: false }; } catch {}
  return { sha: null, dirty: false };
}

function write() {
  localStorage.setItem(KEY, JSON.stringify(db));
  setSync({ dirty: true });
  schedulePush();
}

function setSync(change) {
  sync = { ...sync, ...change };
  localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
}

// ---------- GitHub backup ----------

// 'off' (no token), 'ok', 'offline' (will retry), 'denied' (token expired, revoked or lacks access).
let status = localStorage.getItem(TOKEN_KEY) ? 'ok' : 'off';
let onStatus = () => {};
function setStatus(s) {
  if (s !== status) { status = s; onStatus(s); }
}
const syncing = () => status === 'ok' || status === 'offline';

export const syncStatus = () => status;
export function watchSync(fn) { onStatus = fn; }

async function github(method, body, opts = {}) {
  const res = await fetch(FILE_URL, {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY)}`, Accept: 'application/vnd.github+json' },
    body: body && JSON.stringify(body),
    ...opts,
  });
  // A token without access to the repo gets 404s; a GET 404 can also just mean no file yet.
  if (res.status === 401 || res.status === 403 || (res.status === 404 && method === 'PUT')) {
    setStatus('denied');
    throw new Error('denied');
  }
  if (!res.ok && res.status !== 404) throw new Error(res.status);
  return res;
}

const toBase64 = text => btoa(Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join(''));
const fromBase64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

// Brings local and remote together: edits not yet pushed since the last sync win,
// otherwise the repo does. A fresh install has no sha, so it takes what the repo has.
async function pull(signal) {
  const res = await github('GET', null, { signal });
  if (res.status === 404) return push();
  const file = await res.json();
  if (sync.dirty && sync.sha) {
    setSync({ sha: file.sha });
    return push();
  }
  db = withDefaults(JSON.parse(fromBase64(file.content)));
  localStorage.setItem(KEY, JSON.stringify(db));
  setSync({ sha: file.sha, dirty: false });
  setStatus('ok');
}

let timer = null;
let pushing = null;
function schedulePush() {
  clearTimeout(timer);
  if (syncing()) timer = setTimeout(push, 1500);
}

// One push at a time; edits made while one is in flight go out right after.
async function push(keepalive = false) {
  clearTimeout(timer);
  while (pushing) await pushing;
  if (!sync.dirty && sync.sha) return;
  pushing = (async () => {
    const text = JSON.stringify(db, null, 1);
    const body = { message: 'Update data', content: toBase64(text), ...(sync.sha && { sha: sync.sha }) };
    try {
      let res = await github('PUT', body, { keepalive }).catch(e => {
        if (e.message === '409' || e.message === '422') return null; // repo moved on: overwrite with ours
        throw e;
      });
      if (!res) {
        const head = await github('GET');
        body.sha = head.ok ? (await head.json()).sha : undefined;
        res = await github('PUT', body);
      }
      setSync({ sha: (await res.json()).content.sha, dirty: JSON.stringify(db, null, 1) !== text });
      setStatus('ok');
    } catch (e) {
      if (e.message !== 'denied') setStatus('offline');
    } finally {
      pushing = null;
    }
  })();
  return pushing;
}

// Flush when the app is backgrounded (keepalive lets that request outlive the page);
// anything that still didn't make it goes on the next launch or reconnect.
document.addEventListener('visibilitychange', () => {
  if (syncing() && sync.dirty) push(document.hidden);
});
window.addEventListener('online', () => { if (syncing() && sync.dirty) push(); });

// Saves the token and syncs with it. Resolves to the data to show, or throws
// 'denied' when GitHub refuses the token and 'offline' when it can't be reached.
export async function connect(token) {
  localStorage.setItem(TOKEN_KEY, token.trim());
  status = 'ok';
  await pull().catch(e => { if (e.message !== 'denied') setStatus('offline'); });
  if (status !== 'ok') {
    const reason = status;
    localStorage.removeItem(TOKEN_KEY);
    status = 'off';
    throw new Error(reason);
  }
  return structuredClone(db);
}

function upsert(list, record) {
  const i = list.findIndex(r => r.id === record.id);
  if (i === -1) list.push(record); else list[i] = record;
}

export async function load() {
  if (status !== 'off') {
    // Don't hold up launch for long without a connection; the cache is shown instead.
    const ctl = new AbortController();
    await Promise.race([
      pull(ctl.signal).catch(e => { if (e.message !== 'denied') setStatus('offline'); }),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ]);
    ctl.abort(); // a late answer must not replace data the UI is already showing
  }
  return structuredClone(db);
}

export async function saveItems(items) {
  for (const item of items) upsert(db.items, structuredClone(item));
  write();
}

export async function saveDay(day) {
  db.days[day.date] = structuredClone(day);
  write();
}

export async function savePlan(text) {
  db.plan = { text, updatedAt: new Date().toISOString() };
  write();
}

export async function saveNote(note) {
  upsert(db.notes, structuredClone(note));
  write();
}

export async function deleteNote(id) {
  db.notes = db.notes.filter(n => n.id !== id);
  write();
}

export async function saveTasks(tasks) {
  for (const task of tasks) upsert(db.tasks, structuredClone(task));
  write();
}

export async function deleteTask(id) {
  db.tasks = db.tasks.filter(t => t.id !== id);
  write();
}

// An emptied note is dropped rather than kept as a blank.
export async function saveDayNote(note) {
  if (note.body.trim()) db.dayNotes[note.date] = structuredClone(note);
  else delete db.dayNotes[note.date];
  write();
}

export async function saveGoals(goals) {
  for (const goal of goals) upsert(db.goals, structuredClone(goal));
  write();
}

// Takes the goal's checkpoints with it.
export async function deleteGoal(id) {
  db.goals = db.goals.filter(g => g.id !== id);
  db.checkpoints = db.checkpoints.filter(c => c.goalId !== id);
  write();
}

export async function saveCheckpoints(checkpoints) {
  for (const cp of checkpoints) upsert(db.checkpoints, structuredClone(cp));
  write();
}

export async function deleteCheckpoint(id) {
  db.checkpoints = db.checkpoints.filter(c => c.id !== id);
  write();
}
