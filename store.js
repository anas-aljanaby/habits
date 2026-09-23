// Persistence boundary. The UI only calls the functions exported here, and each
// record type maps to a future Supabase table:
//
//   items  { id, title, counts, position, createdOn, deletedOn }
//   days   { date, required: [itemId], done: [itemId] }
//   plan   { text, updatedAt }                  (single row)
//   notes  { id, body, updatedAt }
//
// Dates are local 'YYYY-MM-DD' strings. Everything is async so a network-backed
// version can drop in without touching the callers.

const KEY = 'tally.v1';
const LEGACY_KEY = 'habits.v1'; // first version of this app, same origin

let db = read();

function read() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    if (data && Array.isArray(data.items)) return data;
  } catch {}
  return migrateLegacy() || { items: [], days: {}, plan: { text: '', updatedAt: null }, notes: [] };
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

function write() {
  localStorage.setItem(KEY, JSON.stringify(db));
}

function upsert(list, record) {
  const i = list.findIndex(r => r.id === record.id);
  if (i === -1) list.push(record); else list[i] = record;
}

export async function load() {
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
