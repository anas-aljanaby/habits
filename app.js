import * as store from './store.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const $app = document.getElementById('app');

const state = {
  items: [],
  days: {},
  plan: '',
  notes: [],
  view: todayKey(),     // the day shown on the home screen
  editingItems: false,
  editingPlan: false,
  popped: null,         // id just ticked, so its box gets the check feedback once
};

// ---------- dates (local 'YYYY-MM-DD') ----------

function keyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayKey() { return keyOf(new Date()); }
function parse(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(k, n) { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); }
const weekday = d => d.toLocaleDateString('en-GB', { weekday: 'long' });
const dayMonth = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

// ---------- habit + streak rules ----------

const sortedItems = () => [...state.items].sort((a, b) => a.position - b.position);
const liveItems = () => sortedItems().filter(i => !i.deletedOn);
const existedOn = (item, k) => item.createdOn <= k && (!item.deletedOn || item.deletedOn > k);

// Items shown for a day: those that existed then, plus anything that day's record mentions.
function itemsOn(k) {
  const day = state.days[k];
  const ref = new Set([...(day?.required ?? []), ...(day?.done ?? [])]);
  return sortedItems().filter(i => existedOn(i, k) || ref.has(i.id));
}

// Streak items as they stand now for that day. Stored in the day record so later
// edits to the list never rewrite history.
function requiredNow(k) {
  return sortedItems().filter(i => existedOn(i, k) && i.counts).map(i => i.id);
}

function isComplete(k) {
  const day = state.days[k];
  return !!day && day.required.length > 0 && day.required.every(id => day.done.includes(id));
}

function streak() {
  let k = todayKey();
  if (!isComplete(k)) k = addDays(k, -1);
  let n = 0;
  while (isComplete(k)) { n++; k = addDays(k, -1); }
  return n;
}

function firstTrackedDay() {
  return Object.keys(state.days).filter(k => state.days[k].done.length).sort()[0] ?? todayKey();
}

// ---------- mutations ----------

function toggle(id) {
  const k = state.view;
  const day = state.days[k] ?? { date: k, required: [], done: [] };
  const wasDone = day.done.includes(id);
  day.done = wasDone ? day.done.filter(x => x !== id) : [...day.done, id];
  // Today tracks the live list; a past day keeps the snapshot it already has.
  if (k === todayKey() || !state.days[k]) day.required = requiredNow(k);
  state.days[k] = day;
  state.popped = wasDone ? null : id;
  store.saveDay(day);
  render();
}

// Keep today's record in step after the list changes.
function syncToday() {
  const day = state.days[todayKey()];
  if (!day) return;
  const live = new Set(liveItems().map(i => i.id));
  day.done = day.done.filter(id => live.has(id));
  day.required = requiredNow(day.date);
  store.saveDay(day);
}

function saveItems(items) {
  store.saveItems(items);
  syncToday();
  render();
}

function addItem(title) {
  title = title.trim();
  if (!title) return;
  const position = Math.max(-1, ...state.items.map(i => i.position)) + 1;
  const item = { id: crypto.randomUUID(), title, counts: true, position, createdOn: todayKey(), deletedOn: null };
  state.items.push(item);
  saveItems([item]);
}

function findItem(id) { return state.items.find(i => i.id === id); }

function reorder(ids) {
  const moved = ids.map((id, position) => Object.assign(findItem(id), { position }));
  saveItems(moved);
}

function goTo(k) {
  const t = todayKey();
  state.view = k > t ? t : k;
  state.editingItems = false;
  render();
}

// Text saves are debounced; flushed when the app is backgrounded.
const pending = new Map();
function later(key, fn) {
  clearTimeout(pending.get(key)?.timer);
  pending.set(key, { fn, timer: setTimeout(() => { pending.delete(key); fn(); }, 400) });
}
function flush() {
  for (const [key, { fn, timer }] of pending) { clearTimeout(timer); pending.delete(key); fn(); }
}

// ---------- markdown: headings, bullets (one level of nesting), bold ----------

function esc(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

function markdown(src) {
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const line of src.split('\n')) {
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      closeList();
      out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`);
    } else if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li${m[1].length >= 2 ? ' class="sub"' : ''}>${inline(m[2])}</li>`);
    } else if (!line.trim()) {
      closeList();
      out.push('<div class="gap"></div>');
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

// ---------- icons ----------

const svg = (d, w = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icon = {
  left: svg('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
  right: svg('<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
  check: svg('<path d="M6 12.5l4 4 8-9"/>', 3),
  notes: svg('<path d="M6.5 3.5h8L18.5 7.5v13h-12z"/><path d="M14 3.5v4.5h4.5"/><path d="M9.5 12.5h5.5M9.5 16h3.5"/>', 1.8),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 3.8h5M6.8 7l.9 12.2c.1.8.7 1.3 1.5 1.3h5.6c.8 0 1.4-.5 1.5-1.3L17.2 7"/>', 1.8),
  grip: svg('<path d="M6 9h12M6 12h12M6 15h12"/>', 1.8),
};
const mark = '<svg class="mark" viewBox="236 300 552 424" aria-hidden="true"><use href="#tally" width="1024" height="1024"/></svg>';

// ---------- views ----------

function home() {
  return `
    <header class="top">
      <div class="brand">${mark}<span>Tally</span></div>
      <button class="round-btn" data-action="notes" aria-label="Notes">${icon.notes}</button>
    </header>
    ${dayCard()}
    ${state.editingItems ? habitEditor() : habitList()}
    ${planBlock()}`;
}

function dayCard() {
  const t = todayKey();
  const v = state.view;
  const d = parse(v);
  const start = addDays(v, -d.getDay());
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const n = streak();
  return `
    <section class="daycard surface">
      <div class="daycard-head">
        <div>
          <h1 class="dayname">${weekday(d)}</h1>
          <div class="dateline">
            <span>${dayMonth(d)}</span>
            ${v === t
              ? '<span class="today-tag">Today</span>'
              : '<button class="today-btn" data-action="today">Go to today</button>'}
          </div>
        </div>
        <div class="stepper">
          <button class="round-btn" data-action="prev" aria-label="Previous day">${icon.left}</button>
          <button class="round-btn" data-action="next" aria-label="Next day" ${v === t ? 'disabled' : ''}>${icon.right}</button>
        </div>
      </div>
      <div class="week">
        <div class="streak${isComplete(t) ? ' is-lit' : ''}">
          <span class="streak-num">${n}</span>
          <span class="streak-label">day streak</span>
        </div>
        <ol class="days" aria-label="Week">
          ${week.map((k, i) => dayCell(k, i, t, v)).join('')}
        </ol>
      </div>
    </section>`;
}

function dayCell(k, i, t, v) {
  const first = firstTrackedDay();
  const status = k > t ? 'future' : isComplete(k) ? 'done' : k === t ? 'open' : k < first ? 'none' : 'missed';
  const next = addDays(k, 1);
  const cls = [
    `is-${status}`,
    k === v && 'is-selected',
    k === t && 'is-today',
    status === 'done' && next <= t && isComplete(next) && 'link-next',
    status === 'done' && i === 0 && isComplete(addDays(k, -1)) && 'link-prev',
  ].filter(Boolean).join(' ');
  const label = parse(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return `
    <li class="${cls}">
      <button class="day" data-action="day" data-date="${k}" ${status === 'future' ? 'disabled' : ''}
        aria-label="${label}, ${status === 'done' ? 'complete' : status === 'missed' ? 'missed' : 'not complete'}"
        ${k === v ? 'aria-current="date"' : ''}>
        <span class="day-label">${DAY_LABELS[parse(k).getDay()]}</span>
        <span class="tile">${status === 'done' ? icon.check : ''}</span>
      </button>
    </li>`;
}

function habitList() {
  const k = state.view;
  const isToday = k === todayKey();
  const items = itemsOn(k);
  const day = state.days[k];
  const done = new Set(day?.done ?? []);
  const required = day?.required ?? requiredNow(k);
  const count = required.filter(id => done.has(id)).length;

  if (!items.length) {
    return `
      <section class="habits">
        <div class="section-head"><h2>Habits</h2></div>
        <div class="empty surface">
          ${isToday
            ? `<p class="empty-title">Your checklist is empty</p>
               <p>Add the things you want to do every day.</p>
               <button class="pill is-primary" data-action="edit-items">Add habits</button>`
            : '<p>Nothing was on the checklist this day.</p>'}
        </div>
      </section>`;
  }

  const popped = state.popped;
  state.popped = null;
  return `
    <section class="habits">
      <div class="section-head">
        <h2>Habits</h2>
        ${required.length ? `<span class="count">${count} of ${required.length}</span>` : ''}
        ${isToday ? '<button class="pill" data-action="edit-items">Edit</button>' : ''}
      </div>
      <ul class="rows surface">
        ${items.map(item => `
          <li>
            <button class="row${done.has(item.id) ? ' is-done' : ''}" data-action="toggle" data-id="${item.id}"
              aria-pressed="${done.has(item.id)}">
              <span class="box${item.counts ? '' : ' is-round'}${popped === item.id ? ' pop' : ''}">${icon.check}</span>
              <span class="row-title">${esc(item.title)}</span>
            </button>
          </li>`).join('')}
      </ul>
      ${items.some(i => !i.counts) ? '<p class="legend">Round items are extras and don’t affect the streak.</p>' : ''}
    </section>`;
}

function habitEditor() {
  return `
    <section class="habits">
      <div class="section-head">
        <h2>Edit habits</h2>
        <button class="pill is-primary" data-action="done-items">Done</button>
      </div>
      <p class="legend">Square habits count toward the streak, round ones don’t. Tap a shape to switch it, drag the handle to reorder.</p>
      ${liveItems().length ? `
        <ul class="rows surface is-editing">
          ${liveItems().map(item => `
            <li class="edit-row" data-id="${item.id}">
              <span class="grip" data-grip aria-label="Reorder">${icon.grip}</span>
              <button class="shape-btn" data-action="flip" data-id="${item.id}"
                aria-label="${item.counts ? 'Counts toward streak' : 'Extra, not counted'}">
                <span class="box${item.counts ? '' : ' is-round'}"></span>
              </button>
              <input class="title-input" data-id="${item.id}" value="${esc(item.title)}" maxlength="80"
                enterkeyhint="done" autocomplete="off" aria-label="Habit name">
              <button class="icon-btn danger" data-action="delete" data-id="${item.id}" aria-label="Delete ${esc(item.title)}">${icon.trash}</button>
            </li>`).join('')}
        </ul>` : ''}
      <form class="add-row surface" data-form="add">
        <input name="title" placeholder="New habit" maxlength="80" enterkeyhint="done" autocomplete="off" aria-label="New habit">
        <button class="pill is-primary" type="submit">Add</button>
      </form>
    </section>`;
}

function planBlock() {
  const body = state.editingPlan
    ? `<textarea class="plan-input" data-plan aria-label="Plan" placeholder="# This week&#10;- Monday: …">${esc(state.plan)}</textarea>`
    : state.plan.trim()
      ? `<div class="md">${markdown(state.plan)}</div>`
      : `<p class="placeholder">Tap to write the plan for the next week or two. Use # for headings, - for bullets, **bold** for emphasis.</p>`;
  return `
    <section class="plan">
      <div class="section-head">
        <h2>Plan</h2>
        <button class="pill${state.editingPlan ? ' is-primary' : ''}" data-action="${state.editingPlan ? 'done-plan' : 'edit-plan'}">
          ${state.editingPlan ? 'Done' : 'Edit'}
        </button>
      </div>
      <div class="plan-body surface${state.editingPlan ? ' is-editing' : ''}" ${state.editingPlan ? '' : 'data-action="edit-plan"'}>${body}</div>
    </section>`;
}

function notesList() {
  const notes = [...state.notes].filter(n => n.body.trim()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return `
    <header class="top">
      <button class="back-btn" data-action="home">${icon.left}<span>Today</span></button>
      <button class="round-btn" data-action="new-note" aria-label="New note">${icon.plus}</button>
    </header>
    <h1 class="page-title">Notes</h1>
    ${notes.length ? `
      <ul class="rows surface notes">
        ${notes.map(n => {
          const [title, ...rest] = n.body.trim().split('\n');
          const snippet = rest.find(l => l.trim()) ?? '';
          return `
            <li>
              <button class="note" data-action="open-note" data-id="${n.id}">
                <span class="note-title">${esc(title)}</span>
                <time>${noteDate(n.updatedAt)}</time>
                ${snippet ? `<span class="note-snippet">${esc(snippet)}</span>` : ''}
              </button>
            </li>`;
        }).join('')}
      </ul>` : `
      <div class="empty surface">
        <p class="empty-title">No notes yet</p>
        <p>Anything that isn’t part of the plan goes here.</p>
        <button class="pill is-primary" data-action="new-note">New note</button>
      </div>`}`;
}

function noteDate(iso) {
  const d = new Date(iso);
  return keyOf(d) === todayKey()
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function noteEditor(note) {
  return `
    <header class="top">
      <button class="back-btn" data-action="notes">${icon.left}<span>Notes</span></button>
      <button class="round-btn danger" data-action="delete-note" data-id="${note.id}" aria-label="Delete note">${icon.trash}</button>
    </header>
    <div class="note-sheet surface">
      <textarea class="note-input" data-note="${note.id}" placeholder="Title on the first line, then anything else" aria-label="Note">${esc(note.body)}</textarea>
    </div>`;
}

// ---------- render + routing ----------

let openNoteId = null;

function render() {
  const [route, id] = location.hash.slice(1).split('/');
  const note = route === 'notes' && id ? state.notes.find(n => n.id === id) : null;

  // Leaving a note that was never written in drops it rather than keeping a blank.
  if (openNoteId && openNoteId !== note?.id) {
    const left = state.notes.find(n => n.id === openNoteId);
    if (left && !left.body.trim()) {
      state.notes = state.notes.filter(n => n !== left);
      store.deleteNote(left.id);
    }
  }
  openNoteId = note?.id ?? null;

  $app.innerHTML = note ? noteEditor(note) : route === 'notes' ? notesList() : home();
  document.body.dataset.screen = note ? 'note' : route === 'notes' ? 'notes' : 'home';

  const area = $app.querySelector('textarea');
  if (area) {
    autosize(area);
    if (state.editingPlan || (note && !note.body)) area.focus();
  }
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ---------- events ----------

const actions = {
  toggle: el => toggle(el.dataset.id),
  day: el => goTo(el.dataset.date),
  prev: () => goTo(addDays(state.view, -1)),
  next: () => goTo(addDays(state.view, 1)),
  today: () => goTo(todayKey()),
  'edit-items': () => { state.editingItems = true; render(); },
  'done-items': () => { state.editingItems = false; flush(); render(); },
  flip: el => { const item = findItem(el.dataset.id); item.counts = !item.counts; saveItems([item]); },
  delete: el => {
    const item = findItem(el.dataset.id);
    if (!confirm(`Delete “${item.title}”? Past days keep their record.`)) return;
    item.deletedOn = todayKey();
    saveItems([item]);
  },
  'edit-plan': () => { if (!state.editingPlan) { state.editingPlan = true; render(); } },
  'done-plan': () => { state.editingPlan = false; flush(); render(); },
  home: () => { location.hash = ''; },
  notes: () => { location.hash = 'notes'; },
  'new-note': () => {
    const note = { id: crypto.randomUUID(), body: '', updatedAt: new Date().toISOString() };
    state.notes.push(note);
    location.hash = `notes/${note.id}`;
  },
  'open-note': el => { location.hash = `notes/${el.dataset.id}`; },
  'delete-note': el => {
    if (!confirm('Delete this note?')) return;
    state.notes = state.notes.filter(n => n.id !== el.dataset.id);
    store.deleteNote(el.dataset.id);
    location.hash = 'notes';
  },
};

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  // Tapping anywhere else while the plan is open closes it first.
  if (state.editingPlan && !el.closest('.plan')) { state.editingPlan = false; flush(); }
  actions[el.dataset.action]?.(el);
});

$app.addEventListener('input', e => {
  const el = e.target;
  if (el.matches('[data-plan]')) {
    state.plan = el.value;
    autosize(el);
    later('plan', () => store.savePlan(state.plan));
  } else if (el.matches('[data-note]')) {
    const note = state.notes.find(n => n.id === el.dataset.note);
    note.body = el.value;
    note.updatedAt = new Date().toISOString();
    autosize(el);
    later(note.id, () => store.saveNote(note));
  } else if (el.matches('.title-input') && el.value.trim()) {
    const item = findItem(el.dataset.id);
    item.title = el.value.trim();
    later(item.id, () => store.saveItems([item]));
  }
});

// A rename cleared to nothing snaps back to the saved title.
$app.addEventListener('change', e => {
  if (e.target.matches('.title-input') && !e.target.value.trim()) e.target.value = findItem(e.target.dataset.id).title;
});

$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.title-input')) e.target.blur();
});

$app.addEventListener('submit', e => {
  e.preventDefault();
  const input = e.target.elements.title;
  addItem(input.value);
  $app.querySelector('[data-form="add"] input')?.focus();
});

// Swipe across the week strip to move a week at a time.
let swipe = null;
$app.addEventListener('touchstart', e => {
  swipe = e.target.closest('.days') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
$app.addEventListener('touchend', e => {
  if (!swipe) return;
  const dx = e.changedTouches[0].clientX - swipe.x;
  const dy = e.changedTouches[0].clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) goTo(addDays(state.view, dx < 0 ? 7 : -7));
});

// Drag to reorder in edit mode. Rows are equal height, so the target slot is just dy / height.
$app.addEventListener('pointerdown', e => {
  const grip = e.target.closest('[data-grip]');
  if (!grip) return;
  e.preventDefault();
  const row = grip.closest('li');
  const rows = [...row.parentElement.children];
  const from = rows.indexOf(row);
  const h = row.offsetHeight;
  const startY = e.clientY;
  let to = from;
  row.classList.add('dragging');
  grip.setPointerCapture(e.pointerId);

  const move = ev => {
    const dy = ev.clientY - startY;
    to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)));
    row.style.transform = `translateY(${dy}px)`;
    rows.forEach((r, i) => {
      if (r === row) return;
      const shift = i > from && i <= to ? -h : i < from && i >= to ? h : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const end = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    const ids = rows.map(r => r.dataset.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    reorder(ids);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
});

window.addEventListener('hashchange', () => { flush(); render(); });

// Ticks reset at midnight: if the app was showing "today", follow it to the new day.
let lastToday = todayKey();
function checkDate() {
  const t = todayKey();
  if (t === lastToday) return;
  if (state.view === lastToday) state.view = t;
  lastToday = t;
  if (document.body.dataset.screen === 'home' && !state.editingPlan) render();
}
document.addEventListener('visibilitychange', () => (document.hidden ? flush() : checkDate()));
window.addEventListener('pagehide', flush);
setInterval(checkDate, 30_000);

// ---------- start ----------

const data = await store.load();
state.items = data.items;
state.days = data.days;
state.plan = data.plan.text;
state.notes = data.notes;
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
