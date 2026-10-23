import * as store from './store.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const $app = document.getElementById('app');

const state = {
  items: [],
  days: {},
  plan: '',
  notes: [],
  tasks: [],
  dayNotes: {},
  goals: [],
  checkpoints: [],
  view: todayKey(),     // the day shown on the home screen
  editingPlan: false,
  popped: null,         // id just ticked, so its box gets the check feedback once
  poppedTask: null,
  poppedCheck: null,
  slide: null,          // 'back' | 'forward' after a week change, so the strip moves that way once
  historyQuery: '',
  taskDraft: '',        // the half-typed new task survives re-renders
  connecting: false,
  backupError: '',
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
const fullDate = k => parse(k).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', ...(k.slice(0, 4) !== todayKey().slice(0, 4) && { year: 'numeric' }),
});
function relDay(k) {
  const t = todayKey();
  return k === t ? 'Today' : k === addDays(t, -1) ? 'Yesterday' : weekday(parse(k));
}
// Weeks run Saturday to Friday.
const weekStart = k => addDays(k, -((parse(k).getDay() + 1) % 7));
function weekRange(start) {
  const a = parse(start);
  const b = parse(addDays(start, 6));
  const month = d => d.toLocaleDateString('en-GB', { month: 'short' });
  return a.getMonth() === b.getMonth()
    ? `${a.getDate()} – ${b.getDate()} ${month(b)}`
    : `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)}`;
}
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const shortDate = k => parse(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
function untilLabel(k) {
  const n = daysBetween(todayKey(), k);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`;
}
function countdown(n) {
  return n === 0 ? 'Due today' : n > 0 ? `${n} ${n === 1 ? 'day' : 'days'} left` : `${-n} ${n === -1 ? 'day' : 'days'} past`;
}

// ---------- text direction: each piece of user text runs the way its first strong letter does ----------

const STRONG = /[A-Za-z\u00C0-\u024F\u0370-\u04FF\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const dirOf = s => (RTL.test(s.match(STRONG)?.[0] ?? '') ? 'rtl' : 'ltr');

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
  const from = weekStart(state.view);
  state.view = k > t ? t : k;
  const to = weekStart(state.view);
  state.slide = to < from ? 'back' : to > from ? 'forward' : null;
  render();
}

// ---------- daily tasks: one-off to-dos for a date, apart from habits and the streak ----------

const tasksOn = k => state.tasks.filter(t => t.date === k).sort((a, b) => a.position - b.position);
const findTask = id => state.tasks.find(t => t.id === id);
const nextPosition = k => Math.max(-1, ...tasksOn(k).map(t => t.position)) + 1;

function addTask(title) {
  title = title.trim();
  if (!title) return;
  const task = { id: crypto.randomUUID(), date: state.view, title, done: false, position: nextPosition(state.view) };
  state.tasks.push(task);
  store.saveTasks([task]);
}

function toggleTask(id) {
  const task = findTask(id);
  task.done = !task.done;
  state.poppedTask = task.done ? id : null;
  store.saveTasks([task]);
  render();
}

function removeTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  store.deleteTask(id);
  render();
}

// What was left open on the last day before today that had tasks; offered on today.
function leftovers() {
  const t = todayKey();
  const last = state.tasks.reduce((m, task) => (task.date < t && task.date > m ? task.date : m), '');
  return { date: last, tasks: tasksOn(last).filter(task => !task.done) };
}

function carryOver() {
  const t = todayKey();
  const moved = leftovers().tasks;
  let position = nextPosition(t);
  for (const task of moved) Object.assign(task, { date: t, position: position++ });
  store.saveTasks(moved);
  render();
}

// ---------- goals: a deadline with dated check-ins along the way ----------

const activeGoals = () => state.goals.filter(g => !g.archivedOn).sort((a, b) => a.deadline.localeCompare(b.deadline));
const pastGoals = () => state.goals.filter(g => g.archivedOn).sort((a, b) => b.archivedOn.localeCompare(a.archivedOn));
const findGoal = id => state.goals.find(g => g.id === id);
const findCheckpoint = id => state.checkpoints.find(c => c.id === id);
const checkpointsOf = id => state.checkpoints.filter(c => c.goalId === id).sort((a, b) => a.date.localeCompare(b.date));
const goalTitle = goal => goal?.title || 'Untitled goal';

// Check-ins shown on a day: those dated that day, and on today any an active goal left unticked.
function checkInsOn(k) {
  const t = todayKey();
  const active = new Set(activeGoals().map(g => g.id));
  return state.checkpoints
    .filter(c => (c.date === k && (active.has(c.goalId) || c.doneOn)) || (k === t && c.date < t && !c.doneOn && active.has(c.goalId)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Saved on its first edit; one left without a name or check-ins is dropped (see render).
function newGoal() {
  const t = todayKey();
  const goal = { id: crypto.randomUUID(), title: '', deadline: addDays(t, 30), createdOn: t, archivedOn: null, outcome: null };
  state.goals.push(goal);
  location.hash = `goal/${goal.id}`;
}

function addCheckpoint(goalId) {
  const goal = findGoal(goalId);
  const t = todayKey();
  const week = addDays(t, 7);
  const cp = {
    id: crypto.randomUUID(), goalId, date: goal.deadline < week ? (goal.deadline < t ? t : goal.deadline) : week,
    title: '', notes: '', doneOn: null,
  };
  state.checkpoints.push(cp);
  store.saveGoals([goal]);
  store.saveCheckpoints([cp]);
  render();
  $app.querySelector(`[data-cp="${cp.id}"][data-field="title"]`)?.focus();
}

function toggleCheckIn(id) {
  const cp = findCheckpoint(id);
  cp.doneOn = cp.doneOn ? null : todayKey();
  state.poppedCheck = cp.doneOn ? id : null;
  store.saveCheckpoints([cp]);
  render();
}

function archiveGoal(id, outcome) {
  const goal = findGoal(id);
  Object.assign(goal, { archivedOn: outcome && todayKey(), outcome });
  store.saveGoals([goal]);
  location.hash = 'plan';
}

function removeCheckpoint(id) {
  state.checkpoints = state.checkpoints.filter(c => c.id !== id);
  store.deleteCheckpoint(id);
}

function removeGoal(id) {
  state.goals = state.goals.filter(g => g.id !== id);
  state.checkpoints = state.checkpoints.filter(c => c.goalId !== id);
  store.deleteGoal(id);
}

// Leaving a goal's page drops blank check-ins, and the goal itself if nothing was written.
function tidyGoal(id) {
  const goal = findGoal(id);
  if (!goal) return;
  for (const c of checkpointsOf(id)) if (!c.title.trim() && !c.notes.trim()) removeCheckpoint(c.id);
  if (!goal.title.trim() && !checkpointsOf(id).length) removeGoal(id);
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

// ---------- markdown: headings, bullets (one level of nesting), bold; each line sets its own direction ----------

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
      out.push(`<h${m[1].length + 2} dir="auto">${inline(m[2])}</h${m[1].length + 2}>`);
    } else if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li dir="auto"${m[1].length >= 2 ? ' class="sub"' : ''}>${inline(m[2])}</li>`);
    } else if (!line.trim()) {
      closeList();
      out.push('<div class="gap"></div>');
    } else {
      closeList();
      out.push(`<p dir="auto">${inline(line)}</p>`);
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
  x: svg('<path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/>', 1.8),
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
    ${backupBanner()}
    ${focusCard()}
    ${dayCard()}
    ${checkIns()}
    ${habitList()}
    ${taskList()}`;
}

// The nearest active goal: its countdown and what's next. Opens the plan.
function focusCard() {
  const goals = activeGoals();
  if (!goals.length) {
    return `
      <button class="focus surface is-empty" data-action="new-goal">
        <span class="focus-head"><span class="kicker">Focus</span></span>
        <span class="focus-empty">Set a goal with a deadline, and check-ins to see if you’re on track.</span>
        <span class="focus-add">${icon.plus}</span>
      </button>`;
  }
  const goal = goals[0];
  const left = daysBetween(todayKey(), goal.deadline);
  const next = checkpointsOf(goal.id).find(c => !c.doneOn);
  return `
    <button class="focus surface" data-action="plan" aria-label="Open plan">
      <span class="focus-head">
        <span class="kicker">Focus${goals.length > 1 ? ` · ${goals.length} goals` : ''}</span>
        <span class="focus-due">by ${shortDate(goal.deadline)}</span>
      </span>
      <span class="focus-title" dir="auto">${esc(goalTitle(goal))}</span>
      <span class="focus-count">
        <span class="focus-num${left < 0 ? ' is-over' : ''}">${Math.abs(left)}</span>
        <span class="focus-unit">${left === 0 ? 'due today' : `${Math.abs(left) === 1 ? 'day' : 'days'} ${left < 0 ? 'past' : 'left'}`}</span>
        ${track(goal)}
      </span>
      ${next ? `
        <span class="focus-next${next.date <= todayKey() ? ' is-due' : ''}">
          <span class="focus-next-when">${next.date === todayKey() ? 'Check-in today' : next.date < todayKey()
            ? `Check-in was due ${shortDate(next.date)}` : `Next check-in · ${shortDate(next.date)} · ${untilLabel(next.date)}`}</span>
          <span class="focus-next-title" dir="auto">${esc(next.title || 'Check-in')}</span>
        </span>` : ''}
    </button>`;
}

// Time from the goal's start to its deadline, filled up to today, with its check-ins as dots.
function track(goal) {
  const span = Math.max(1, daysBetween(goal.createdOn, goal.deadline));
  const at = k => Math.max(0, Math.min(100, (daysBetween(goal.createdOn, k) / span) * 100));
  return `
    <span class="track" aria-hidden="true">
      <span class="track-fill" style="width:${at(todayKey())}%"></span>
      ${checkpointsOf(goal.id).map(c => `<span class="track-dot${c.doneOn ? ' is-done' : ''}" style="left:${at(c.date)}%"></span>`).join('')}
    </span>`;
}

function checkIns() {
  const list = checkInsOn(state.view);
  if (!list.length) return '';
  const popped = state.poppedCheck;
  state.poppedCheck = null;
  return `
    <section class="checkins">
      <div class="section-head"><h2>Check-in</h2></div>
      <ul class="rows surface checkin-list">
        ${list.map(c => `
          <li class="checkin${c.doneOn ? ' is-done' : ''}" dir="${dirOf(c.title)}">
            <button class="checkin-box" data-action="toggle-check" data-id="${c.id}" aria-pressed="${!!c.doneOn}"
              aria-label="${esc(c.title || 'Check-in')}">
              <span class="box${popped === c.id ? ' pop' : ''}">${icon.check}</span>
            </button>
            <div class="checkin-body">
              <span class="checkin-goal" dir="auto">${esc(goalTitle(findGoal(c.goalId)))}</span>
              <span class="checkin-title" dir="auto">${esc(c.title || 'Check-in')}</span>
              ${c.date !== state.view ? `<span class="tag">Due ${shortDate(c.date)}</span>` : ''}
              ${c.notes.trim() ? `<div class="md checkin-notes">${markdown(c.notes)}</div>` : ''}
            </div>
          </li>`).join('')}
      </ul>
    </section>`;
}

function dayCard() {
  const t = todayKey();
  const v = state.view;
  const d = parse(v);
  const start = weekStart(v);
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const n = streak();
  const weeksBack = daysBetween(start, weekStart(t)) / 7;
  const slide = state.slide;
  state.slide = null;
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
          <button class="round-btn" data-action="prev" aria-label="Previous week">${icon.left}</button>
          <button class="round-btn${weeksBack ? ' is-toward-now' : ''}" data-action="next" aria-label="Next week"
            ${weeksBack ? '' : 'disabled'}>${icon.right}</button>
        </div>
      </div>
      ${weeksBack ? `
        <p class="week-off">
          <span>${weeksBack === 1 ? 'Last week' : `${weeksBack} weeks ago`}</span>
          ${weekRange(start)}
        </p>` : ''}
      <div class="week${slide ? ` slide-${slide}` : ''}">
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
  const mark = checkInsOn(k).length ? 'check-in' : tasksOn(k).length ? 'tasks' : '';
  return `
    <li class="${cls}">
      <button class="day" data-action="day" data-date="${k}" ${status === 'future' ? 'disabled' : ''}
        aria-label="${label}, ${status === 'done' ? 'complete' : status === 'missed' ? 'missed' : 'not complete'}${mark ? `, has ${mark}` : ''}"
        ${k === v ? 'aria-current="date"' : ''}>
        <span class="day-label">${DAY_LABELS[parse(k).getDay()]}</span>
        <span class="tile">${status === 'done' ? icon.check : ''}</span>
        ${mark ? `<span class="day-dot${mark === 'check-in' ? ' is-check' : ''}"></span>` : ''}
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
               <button class="pill is-primary" data-action="habits">Add habits</button>`
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
        <button class="pill" data-action="habits">Edit</button>
      </div>
      <ul class="habit-strip surface" dir="${dirOf(items[0].title)}">
        ${items.map(item => `
          <li>
            <button class="habit${done.has(item.id) ? ' is-done' : ''}" data-action="toggle" data-id="${item.id}"
              aria-pressed="${done.has(item.id)}" dir="${dirOf(item.title)}">
              <span class="box${item.counts ? '' : ' is-round'}${popped === item.id ? ' pop' : ''}">${icon.check}</span>
              <span class="habit-title">${esc(item.title)}</span>
            </button>
          </li>`).join('')}
      </ul>
    </section>`;
}

function habitsPage() {
  return `
    <header class="top">
      <button class="back-btn" data-action="home">${icon.left}<span>Today</span></button>
    </header>
    <h1 class="page-title">Habits</h1>
    <p class="legend page-legend">Square habits count toward the streak, round ones are extras that don’t. Tap a shape to switch it, drag the handle to reorder.</p>
    ${liveItems().length ? `
      <ul class="rows surface is-editing">
        ${liveItems().map(item => `
          <li class="edit-row" data-id="${item.id}" dir="${dirOf(item.title)}">
            <span class="grip" data-grip aria-label="Reorder">${icon.grip}</span>
            <button class="shape-btn" data-action="flip" data-id="${item.id}"
              aria-label="${item.counts ? 'Counts toward streak' : 'Extra, not counted'}">
              <span class="box${item.counts ? '' : ' is-round'}"></span>
            </button>
            <input class="title-input" data-id="${item.id}" value="${esc(item.title)}" maxlength="80" dir="auto"
              enterkeyhint="done" autocomplete="off" aria-label="Habit name">
            <button class="icon-btn danger" data-action="delete" data-id="${item.id}" aria-label="Delete ${esc(item.title)}">${icon.trash}</button>
          </li>`).join('')}
      </ul>` : ''}
    <form class="add-row surface" data-form="add">
      <input name="title" placeholder="New habit" maxlength="80" dir="auto" enterkeyhint="done" autocomplete="off" aria-label="New habit">
      <button class="pill is-primary" type="submit">Add</button>
    </form>`;
}

function taskBox(task, popped) {
  return `
    <button class="task-box" data-action="toggle-task" data-id="${task.id}" aria-pressed="${task.done}"
      aria-label="${esc(task.title)}">
      <span class="tick${popped === task.id ? ' pop' : ''}">${icon.check}</span>
    </button>`;
}

function taskList() {
  const k = state.view;
  const tasks = tasksOn(k);
  const done = tasks.filter(t => t.done).length;
  const carry = k === todayKey() ? leftovers() : null;
  const popped = state.poppedTask;
  state.poppedTask = null;
  return `
    <section class="tasks">
      <div class="section-head">
        <h2>Tasks</h2>
        ${tasks.length ? `<span class="count">${done} of ${tasks.length}</span>` : ''}
        <button class="pill" data-action="tasks">History</button>
      </div>
      <ul class="rows surface tasklist">
        ${tasks.map(task => `
          <li class="task${task.done ? ' is-done' : ''}" dir="${dirOf(task.title)}">
            ${taskBox(task, popped)}
            <input class="task-input" data-task="${task.id}" value="${esc(task.title)}" maxlength="200" dir="auto"
              enterkeyhint="done" autocomplete="off" aria-label="Task">
            <button class="icon-btn" data-action="delete-task" data-id="${task.id}" aria-label="Delete ${esc(task.title)}">${icon.x}</button>
          </li>`).join('')}
        <li>
          <form class="task-add" data-form="task">
            <span class="task-plus">${icon.plus}</span>
            <input name="title" value="${esc(state.taskDraft)}" placeholder="${k === todayKey() ? 'What needs doing today?' : 'Add a task'}"
              maxlength="200" dir="auto" enterkeyhint="done" autocomplete="off" aria-label="New task">
          </form>
        </li>
      </ul>
      ${carry?.tasks.length ? `
        <button class="carry" data-action="carry">
          Move ${carry.tasks.length} unfinished from ${carry.date === addDays(k, -1) ? 'yesterday'
            : carry.date > addDays(k, -7) ? weekday(parse(carry.date)) : fullDate(carry.date)} to today
        </button>` : ''}
      <div class="daynote surface">
        <textarea data-daynote="${k}" dir="auto" rows="1" aria-label="Note for the day"
          placeholder="Note for the day">${esc(state.dayNotes[k]?.body ?? '')}</textarea>
      </div>
    </section>`;
}

// Case, Arabic diacritics and alef/yaa/taa marbuta forms don't matter when searching.
const fold = s => s.toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');

function taskHistory() {
  return `
    <header class="top">
      <button class="back-btn" data-action="home">${icon.left}<span>Today</span></button>
    </header>
    <h1 class="page-title">History</h1>
    <div class="search surface">
      <input type="search" data-search value="${esc(state.historyQuery)}" placeholder="Search tasks and notes" dir="auto"
        autocomplete="off" enterkeyhint="search" aria-label="Search tasks and notes">
    </div>
    <div class="history-results">${historyResults()}</div>`;
}

function historyResults() {
  const q = fold(state.historyQuery.trim());
  const hit = s => !q || fold(s).includes(q);
  const noted = Object.keys(state.dayNotes).filter(k => state.dayNotes[k].body.trim());
  const dates = [...new Set([...state.tasks.map(t => t.date), ...noted])].sort().reverse();
  const popped = state.poppedTask;
  state.poppedTask = null;
  const days = dates.map(k => {
    const tasks = tasksOn(k).filter(t => hit(t.title));
    const note = state.dayNotes[k]?.body.trim();
    const showNote = note && hit(note);
    if (!tasks.length && !showNote) return '';
    return `
      <section class="task-day">
        <button class="task-day-head" data-action="open-day" data-date="${k}">
          <span class="task-day-name">${relDay(k)}</span>
          <span class="task-day-date">${fullDate(k)}</span>
          ${tasks.length && !q ? `<span class="count">${tasks.filter(t => t.done).length} of ${tasks.length}</span>` : ''}
        </button>
        ${tasks.length ? `
          <ul class="rows surface tasklist">
            ${tasks.map(task => `
              <li class="task${task.done ? ' is-done' : ''}" dir="${dirOf(task.title)}">
                ${taskBox(task, popped)}
                <span class="task-title">${esc(task.title)}</span>
              </li>`).join('')}
          </ul>` : ''}
        ${showNote ? `<div class="md history-note surface">${markdown(note)}</div>` : ''}
      </section>`;
  }).join('');
  if (days) return days;
  return q ? `
    <div class="empty surface"><p>Nothing matches “${esc(state.historyQuery.trim())}”.</p></div>` : `
    <div class="empty surface">
      <p class="empty-title">Nothing yet</p>
      <p>Tasks and notes you add on a day show up here, newest day first.</p>
    </div>`;
}

function planBlock() {
  const body = state.editingPlan
    ? `<textarea class="plan-input" data-plan dir="auto" aria-label="How my day goes" placeholder="- ورد&#10;- Four hours of work">${esc(state.plan)}</textarea>`
    : state.plan.trim()
      ? `<div class="md">${markdown(state.plan)}</div>`
      : `<p class="placeholder">Tap to write how a typical day goes. Use # for headings, - for bullets, **bold** for emphasis.</p>`;
  return `
    <section class="plan">
      <div class="section-head">
        <h2>How my day goes</h2>
        <button class="pill${state.editingPlan ? ' is-primary' : ''}" data-action="${state.editingPlan ? 'done-plan' : 'edit-plan'}">
          ${state.editingPlan ? 'Done' : 'Edit'}
        </button>
      </div>
      <div class="plan-body surface${state.editingPlan ? ' is-editing' : ''}" ${state.editingPlan ? '' : 'data-action="edit-plan"'}>${body}</div>
    </section>`;
}

function planPage() {
  const goals = activeGoals();
  const past = pastGoals();
  const popped = state.poppedCheck;
  state.poppedCheck = null;
  return `
    <header class="top">
      <button class="back-btn" data-action="home">${icon.left}<span>Today</span></button>
      <button class="round-btn" data-action="new-goal" aria-label="New goal">${icon.plus}</button>
    </header>
    <h1 class="page-title">Plan</h1>
    ${goals.length ? goals.map(g => goalCard(g, popped)).join('') : `
      <div class="empty surface">
        <p class="empty-title">No goal yet</p>
        <p>Give it a deadline, then add check-ins: dates to see whether you’re on track.</p>
        <button class="pill is-primary" data-action="new-goal">New goal</button>
      </div>`}
    ${planBlock()}
    ${past.length ? `
      <section>
        <div class="section-head"><h2>Past goals</h2></div>
        <ul class="rows surface past">
          ${past.map(g => `
            <li>
              <button class="past-goal" data-action="open-goal" data-id="${g.id}">
                <span class="past-title" dir="auto">${esc(goalTitle(g))}</span>
                <span class="tag${g.outcome === 'done' ? ' is-done' : ''}">${g.outcome === 'done' ? 'Achieved' : 'Archived'} ${shortDate(g.archivedOn)}</span>
              </button>
            </li>`).join('')}
        </ul>
      </section>` : ''}`;
}

function goalCard(goal, popped) {
  const cps = checkpointsOf(goal.id);
  const t = todayKey();
  return `
    <section class="goal surface">
      <div class="goal-head" dir="${dirOf(goal.title)}">
        <div class="goal-name-wrap">
          <h2 class="goal-title" dir="auto">${esc(goalTitle(goal))}</h2>
          <p class="goal-due"><span dir="ltr">${countdown(daysBetween(t, goal.deadline))} · ${shortDate(goal.deadline)}</span></p>
        </div>
        <button class="pill" data-action="open-goal" data-id="${goal.id}">Edit</button>
      </div>
      ${track(goal)}
      ${cps.length ? `
        <ol class="steps">
          ${cps.map(c => `
            <li class="step${c.doneOn ? ' is-done' : ''}${c.date === t ? ' is-today' : ''}" dir="${dirOf(c.title)}">
              <button class="step-box" data-action="toggle-check" data-id="${c.id}" aria-pressed="${!!c.doneOn}"
                aria-label="${esc(c.title || 'Check-in')}">
                <span class="box is-round${popped === c.id ? ' pop' : ''}">${icon.check}</span>
              </button>
              <div class="step-body">
                <span class="step-date"><span dir="ltr">${shortDate(c.date)} · ${c.doneOn ? 'done' : untilLabel(c.date)}</span></span>
                <span class="step-title" dir="auto">${esc(c.title || 'Check-in')}</span>
                ${c.notes.trim() ? `<div class="md step-notes">${markdown(c.notes)}</div>` : ''}
              </div>
            </li>`).join('')}
        </ol>` : `<button class="carry" data-action="add-checkpoint" data-id="${goal.id}">Add a check-in</button>`}
    </section>`;
}

function goalEditor(goal) {
  const cps = checkpointsOf(goal.id);
  return `
    <header class="top">
      <button class="back-btn" data-action="plan">${icon.left}<span>Plan</span></button>
      <button class="round-btn danger" data-action="delete-goal" data-id="${goal.id}" aria-label="Delete goal">${icon.trash}</button>
    </header>
    <div class="goal-form surface">
      <input class="goal-input" data-goal="${goal.id}" value="${esc(goal.title)}" maxlength="120" dir="auto"
        placeholder="Goal, e.g. Finish Hifz before travel" enterkeyhint="done" autocomplete="off" aria-label="Goal">
      <label class="field">
        <span>Deadline</span>
        <span class="field-note">${countdown(daysBetween(todayKey(), goal.deadline))}</span>
        <input type="date" data-goal="${goal.id}" value="${goal.deadline}" required>
      </label>
    </div>
    <div class="section-head">
      <h2>Check-ins</h2>
      <button class="pill" data-action="add-checkpoint" data-id="${goal.id}">Add</button>
    </div>
    ${cps.length ? cps.map(c => `
      <div class="cp-form surface">
        <div class="field">
          <span>${untilLabel(c.date).replace(/^./, ch => ch.toUpperCase())}</span>
          <input type="date" data-cp="${c.id}" value="${c.date}" required aria-label="Check-in date">
          <button class="icon-btn danger" data-action="delete-checkpoint" data-id="${c.id}" aria-label="Delete check-in">${icon.trash}</button>
        </div>
        <input class="cp-title" data-cp="${c.id}" data-field="title" value="${esc(c.title)}" maxlength="160" dir="auto"
          placeholder="What to check, e.g. Reached An-Naml 55?" enterkeyhint="done" autocomplete="off" aria-label="Check-in">
        <textarea class="cp-notes" data-cp="${c.id}" data-field="notes" dir="auto" rows="2" aria-label="Notes"
          placeholder="Notes: the target, and what ahead, on track or behind look like">${esc(c.notes)}</textarea>
      </div>`).join('') : `
      <p class="legend page-legend">A check-in is a date to see where you stand. On that day it shows on the home screen to tick.</p>`}
    <div class="goal-actions">
      ${goal.archivedOn ? `
        <p class="legend">${goal.outcome === 'done' ? 'Achieved' : 'Archived'} ${fullDate(goal.archivedOn)}.</p>
        <button class="pill" data-action="restore-goal" data-id="${goal.id}">Make active again</button>` : `
        <button class="pill is-primary" data-action="achieve-goal" data-id="${goal.id}">Mark achieved</button>
        <button class="pill" data-action="archive-goal" data-id="${goal.id}">Archive</button>
        <p class="legend">Both move it to Past goals. Archive is for a goal you replaced or stopped.</p>`}
    </div>`;
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
                <span class="note-title" dir="auto">${esc(title)}</span>
                <time>${noteDate(n.updatedAt)}</time>
                ${snippet ? `<span class="note-snippet" dir="auto">${esc(snippet)}</span>` : ''}
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
      <textarea class="note-input" data-note="${note.id}" dir="auto" placeholder="Title on the first line, then anything else" aria-label="Note">${esc(note.body)}</textarea>
    </div>`;
}

// ---------- backup ----------

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Tally&description=Tally+backup' +
  '&target_name=anas-aljanaby&expires_in=none&contents=write';

function backupBanner() {
  const s = store.syncStatus();
  if (s !== 'off' && s !== 'denied') return '';
  return `
    <div class="empty surface backup-banner">
      <p class="empty-title">${s === 'off' ? 'Backup is off' : 'Backup stopped'}</p>
      <p>${s === 'off'
        ? 'Everything is only on this phone. Turn on backup so deleting the app doesn’t lose it.'
        : 'GitHub no longer accepts the access key. Paste a new one; nothing on this phone is lost.'}</p>
      <button class="pill is-primary" data-action="backup">${s === 'off' ? 'Turn on backup' : 'Fix backup'}</button>
    </div>`;
}

function backupScreen() {
  return `
    <header class="top">
      <button class="back-btn" data-action="home">${icon.left}<span>Today</span></button>
    </header>
    <h1 class="page-title">Backup</h1>
    <div class="empty surface backup">
      <p>Tally keeps a copy of everything in your private <strong>tally-data</strong> repository on GitHub, so it comes back after reinstalling.</p>
      <p>Paste the GitHub access key for it below. Keep the key in your Passwords or Notes app: you paste it again after a reinstall.</p>
      <a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a new key on GitHub</a>
    </div>
    <form class="add-row surface" data-form="backup">
      <input name="token" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" autocorrect="off"
        spellcheck="false" enterkeyhint="go" aria-label="Access key" required>
      <button class="pill is-primary" type="submit" ${state.connecting ? 'disabled' : ''}>${state.connecting ? 'Connecting…' : 'Connect'}</button>
    </form>
    ${state.backupError ? `<p class="legend backup-error">${state.backupError}</p>` : ''}`;
}

async function connect(token) {
  state.connecting = true;
  state.backupError = '';
  render();
  try {
    apply(await store.connect(token));
    location.hash = '';
  } catch (e) {
    state.backupError = e.message === 'denied'
      ? 'GitHub didn’t accept that key. Check it has access to tally-data with Contents set to “Read and write”.'
      : 'Couldn’t reach GitHub. Check the connection and try again.';
  }
  state.connecting = false;
  render();
}

// ---------- render + routing ----------

let openNoteId = null;
let openGoalId = null;

function render() {
  const [route, id] = location.hash.slice(1).split('/');
  const note = route === 'notes' && id ? state.notes.find(n => n.id === id) : null;
  if (openGoalId && openGoalId !== id) tidyGoal(openGoalId);
  const goal = route === 'goal' && id ? findGoal(id) : null;
  const opened = goal && goal.id !== openGoalId;
  openGoalId = goal?.id ?? null;

  // Leaving a note that was never written in drops it rather than keeping a blank.
  if (openNoteId && openNoteId !== note?.id) {
    const left = state.notes.find(n => n.id === openNoteId);
    if (left && !left.body.trim()) {
      state.notes = state.notes.filter(n => n !== left);
      store.deleteNote(left.id);
    }
  }
  openNoteId = note?.id ?? null;

  const screen = note ? 'note' : goal ? 'goal' : ['notes', 'backup', 'tasks', 'plan', 'habits'].includes(route) ? route : 'home';
  $app.innerHTML = {
    note: () => noteEditor(note), goal: () => goalEditor(goal), notes: notesList, backup: backupScreen,
    tasks: taskHistory, plan: planPage, habits: habitsPage, home,
  }[screen]();
  document.body.dataset.screen = screen;

  $app.querySelectorAll('textarea').forEach(autosize);
  if (state.editingPlan) $app.querySelector('[data-plan]')?.focus();
  else if (note && !note.body) $app.querySelector('[data-note]').focus();
  else if (opened && !goal.title) $app.querySelector('.goal-input').focus();
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ---------- events ----------

const actions = {
  toggle: el => toggle(el.dataset.id),
  day: el => goTo(el.dataset.date),
  prev: () => goTo(addDays(state.view, -7)),
  next: () => goTo(addDays(state.view, 7)),
  today: () => goTo(todayKey()),
  habits: () => { location.hash = 'habits'; },
  flip: el => { const item = findItem(el.dataset.id); item.counts = !item.counts; saveItems([item]); },
  delete: el => {
    const item = findItem(el.dataset.id);
    if (!confirm(`Delete “${item.title}”? Past days keep their record.`)) return;
    item.deletedOn = todayKey();
    saveItems([item]);
  },
  'toggle-task': el => toggleTask(el.dataset.id),
  'delete-task': el => removeTask(el.dataset.id),
  carry: carryOver,
  tasks: () => { state.historyQuery = ''; location.hash = 'tasks'; },
  plan: () => { location.hash = 'plan'; },
  'new-goal': newGoal,
  'open-goal': el => { location.hash = `goal/${el.dataset.id}`; },
  'toggle-check': el => toggleCheckIn(el.dataset.id),
  'add-checkpoint': el => { flush(); addCheckpoint(el.dataset.id); },
  'delete-checkpoint': el => {
    const cp = findCheckpoint(el.dataset.id);
    if ((cp.title.trim() || cp.notes.trim()) && !confirm('Delete this check-in?')) return;
    removeCheckpoint(cp.id);
    render();
  },
  'achieve-goal': el => { flush(); archiveGoal(el.dataset.id, 'done'); },
  'archive-goal': el => { flush(); archiveGoal(el.dataset.id, 'dropped'); },
  'restore-goal': el => archiveGoal(el.dataset.id, null),
  'delete-goal': el => {
    if (!confirm('Delete this goal and its check-ins? To keep it under Past goals, archive it instead.')) return;
    removeGoal(el.dataset.id);
    location.hash = 'plan';
  },
  'open-day': el => { goTo(el.dataset.date); location.hash = ''; },
  'edit-plan': () => { if (!state.editingPlan) { state.editingPlan = true; render(); } },
  'done-plan': () => { state.editingPlan = false; flush(); render(); },
  home: () => { location.hash = ''; },
  notes: () => { location.hash = 'notes'; },
  backup: () => { state.backupError = ''; location.hash = 'backup'; },
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
  } else if (el.matches('[data-task]') && el.value.trim()) {
    const task = findTask(el.dataset.task);
    task.title = el.value.trim();
    later(task.id, () => store.saveTasks([task]));
  } else if (el.matches('[data-form="task"] input')) {
    state.taskDraft = el.value;
  } else if (el.matches('[data-search]')) {
    // Only the results redraw, so the field keeps focus and the keyboard stays up.
    state.historyQuery = el.value;
    $app.querySelector('.history-results').innerHTML = historyResults();
  } else if (el.matches('[data-daynote]')) {
    const note = { date: el.dataset.daynote, body: el.value, updatedAt: new Date().toISOString() };
    state.dayNotes[note.date] = note;
    autosize(el);
    later(`day:${note.date}`, () => store.saveDayNote(note));
  } else if (el.matches('.goal-input')) {
    const goal = findGoal(el.dataset.goal);
    goal.title = el.value.trim();
    later(goal.id, () => store.saveGoals([goal]));
  } else if (el.matches('[data-cp][data-field]')) {
    const cp = findCheckpoint(el.dataset.cp);
    cp[el.dataset.field] = el.dataset.field === 'title' ? el.value.trim() : el.value;
    if (el.matches('textarea')) autosize(el);
    later(cp.id, () => store.saveCheckpoints([cp]));
  }
});

// A rename cleared to nothing snaps back to the saved title; a task cleared to nothing is deleted.
$app.addEventListener('change', e => {
  if (e.target.matches('.title-input') && !e.target.value.trim()) e.target.value = findItem(e.target.dataset.id).title;
  if (e.target.matches('[data-task]') && !e.target.value.trim()) removeTask(e.target.dataset.task);
  // Dates take effect at once (countdowns and order move with them); a cleared date keeps the saved one.
  if (e.target.matches('[type="date"]')) {
    const el = e.target;
    if (el.value && el.dataset.goal) {
      const goal = findGoal(el.dataset.goal);
      goal.deadline = el.value;
      store.saveGoals([goal]);
    } else if (el.value) {
      const cp = findCheckpoint(el.dataset.cp);
      cp.date = el.value;
      store.saveCheckpoints([cp]);
    }
    flush();
    render();
  }
});

$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.title-input, [data-task], .goal-input, .cp-title')) e.target.blur();
});

$app.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.dataset.form === 'backup') return connect(e.target.elements.token.value);
  if (e.target.dataset.form === 'task') {
    addTask(e.target.elements.title.value);
    state.taskDraft = '';
    render();
    return $app.querySelector('[data-form="task"] input').focus(); // keep the keyboard up for the next one
  }
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
// Coming back after a while starts on today again, wherever the week strip was left.
let hiddenAt = Date.now();
function resume() {
  checkDate();
  if (Date.now() - hiddenAt < 30 * 60_000 || state.view === todayKey()) return;
  state.view = todayKey();
  if (document.body.dataset.screen === 'home' && !state.editingPlan) render();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return resume();
  hiddenAt = Date.now();
  flush();
});
window.addEventListener('pagehide', flush);
setInterval(checkDate, 30_000);

// ---------- start ----------

function apply(data) {
  state.items = data.items;
  state.days = data.days;
  state.plan = data.plan.text;
  state.notes = data.notes;
  state.tasks = data.tasks;
  state.dayNotes = data.dayNotes;
  state.goals = data.goals;
  state.checkpoints = data.checkpoints;
}

apply(await store.load());
render();
store.watchSync(() => { if (document.body.dataset.screen === 'home' && !state.editingPlan) render(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
