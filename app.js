// Project Dashboard front end. Data comes from the n8n webhooks; the Google Sheet is the database.
// In the sheet and webhooks a task is stored as a "ticket" row; on the page everything is called a task.
const API = 'https://n8n.wippdata.com/webhook/wipp-dashboard';
const CLOSED = ['Done', 'Canceled'];
const LIVE = ['Active', 'Maintenance', 'Ramping up'];
const STATUS_ORDER = ['Active', 'Maintenance', 'Ramping up', 'On hold', 'Prospect', 'Done', 'Canceled'];
const TIME_TYPES = ['Billable', 'Internal', 'Upside', 'Personal'];
const PROJECT_STATUSES = ['Prospect', 'Ramping up', 'Active', 'On hold', 'Maintenance', 'Done', 'Canceled'];
const TASK_STATUSES = ['Open', 'In progress', 'Blocked', 'Backlog'];
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const TASK_STATUS_RANK = { 'In progress': 0, Open: 1, Blocked: 2, Backlog: 3 };
const UP_NEXT_COUNT = 5;
const REPEATS = ['Weekly', 'Every 2 weeks', 'Monthly'];
// Until her 40-hour weeks start, 15 of the 40 hours stay frozen (about 25 working hours)
const FULL_TIME_START = '2027-01-11';
const DEFAULT_FROZEN = 15;
// Nathan's 40-hour framework: paid work 25 to 30, upside software 5 to 10, personal projects 5 to 10
const FRAMEWORK = [
  ['Paid work', ['Billable', 'Internal'], 25, 30, 'Billable plus Internal (client work, admin, check-ins)'],
  ['Upside', ['Upside'], 5, 10, 'Internal tools that could earn revenue, like SPRK'],
  ['Personal', ['Personal'], 5, 10, 'Personal projects, like this dashboard'],
];
const KEY_STORE = 'pd_key';

const $ = (id) => document.getElementById(id);
const state = {
  data: null, client: 'all', showClosed: false, ticketing: false,
  openCards: new Set(), openTasks: new Set(),
  sort: { key: 'priority', dir: 1 }, filter: { project: '', assignee: '', category: '' }, logProject: '',
  // Desktop layout: split (both), next (Up next wide), projects (Up next tucked away)
  layout: 'split', projLayout: 'projects', lastView: 'home', nextFolded: false,
  week: '',
};

// ---------- key handling ----------
function storedKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
function saveKey(k) { try { localStorage.setItem(KEY_STORE, k); } catch (e) { /* private mode: key stays in the URL */ } }
function currentKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) { saveKey(fromUrl); return fromUrl; }
  return storedKey();
}

// ---------- helpers ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const status = (msg) => { $('status-line').textContent = msg || ''; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const idNum = (id) => Number(String(id || '').replace(/\D/g, '')) || 0;
const statusRank = (s) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? 99 : i; };
const toIso = (v) => {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};

// Sends JSON. If the browser blocks it (cross-site check), retries as plain text, which n8n still reads as JSON text.
async function post(path, payload) {
  const body = JSON.stringify({ key: currentKey(), ...payload });
  const send = (type) => fetch(`${API}/${path}`, { method: 'POST', headers: { 'Content-Type': type }, body });
  let res;
  try { res = await send('application/json'); } catch (e) { res = await send('text/plain;charset=UTF-8'); }
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(out.error || `Server answered ${res.status}`);
  return out;
}

// ---------- data lookups ----------
const projectOf = (id) => state.data.projects.find((x) => x.project_id === id);
const projectName = (id) => (projectOf(id) || {}).display_name || id;
const clientOf = (p) => state.data.clients.find((c) => c.client === (p || {}).client) || {};
const isSecondary = (p) => clientOf(p).relationship === 'Internal';
const openIds = () => new Set(state.data.tickets.map((t) => t.ticket_id));
const subtasksOf = (t) => state.data.tickets.filter((k) => k.parent_ticket === t.ticket_id);
const isTopLevel = (t, ids = openIds()) => !t.parent_ticket || !ids.has(t.parent_ticket);
const parseLinks = (text) => String(text || '').split('\n').map((line) => {
  const i = line.indexOf('|');
  const name = (i < 0 ? '' : line.slice(0, i)).trim();
  const url = (i < 0 ? line : line.slice(i + 1)).trim();
  return { name: name || url, url };
}).filter((l) => /^https?:\/\//.test(l.url));
const tasksOfProject = (id) => state.data.tickets.filter((t) => t.project === id);
const hoursLogged = (id) => Math.round(state.data.log.filter((l) => l.project === id).reduce((s, l) => s + (Number(l.actual_hours) || 0), 0) * 100) / 100;
function hoursText(p) {
  const used = hoursLogged(p.project_id);
  const alloc = Number(p.allocated_hours) || 0;
  if (alloc) return `${used} of ${alloc} hours used`;
  return used ? `${used} hours logged` : '';
}

// Primary client projects that are live come first, then live WIPP projects, then everything on hold or not started
function projectGroup(p) {
  if (!p) return 3;
  if (!LIVE.includes(p.status)) return 2;
  return isSecondary(p) ? 1 : 0;
}

// Chain-linked next steps: a task with open subtasks is never shown itself. Its first open subtask
// (by task number, Backlog last) stands in for it, all the way down. That step inherits the parent's
// priority when the parent's is higher, so a High parent always surfaces its next step as High.
const sortSubs = (list) => [...list].sort(byStatusThenId);
function nextStep(t) {
  const kids = sortSubs(subtasksOf(t)).filter((k) => k.status !== 'Backlog');
  return kids.length ? nextStep(kids[0]) : t;
}
const topRank = (a, b) => Math.min(PRIORITY_RANK[a] ?? 2, PRIORITY_RANK[b] ?? 2);
const RANK_NAME = ['High', 'Medium', 'Low'];
function upNext() {
  const d = state.data;
  const ids = openIds();
  const me = d.user.name;
  const seen = new Set();
  return d.tickets
    .filter((t) => isTopLevel(t, ids) && t.status !== 'Backlog')
    .map((root) => {
      const step = nextStep(root);
      const mine = split(step.assignee).includes(me) || (!step.assignee && step !== root && split(root.assignee).includes(me));
      if (!mine || seen.has(step.ticket_id)) return null;
      seen.add(step.ticket_id);
      const parent = step === root ? null : d.tickets.find((x) => x.ticket_id === step.parent_ticket);
      const eff = RANK_NAME[topRank(step.priority, root.priority)];
      return { ...step, _priority: eff, _from: eff !== (step.priority || 'Low') ? root.ticket_id : '', _parent: parent };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const pa = projectOf(a.project); const pb = projectOf(b.project);
      return (PRIORITY_RANK[a._priority] ?? 3) - (PRIORITY_RANK[b._priority] ?? 3)
        || (toIso(a.due_date) || '9999').localeCompare(toIso(b.due_date) || '9999')
        || projectGroup(pa) - projectGroup(pb)
        || tasksOfProject(b.project).length - tasksOfProject(a.project).length
        || idNum(a.ticket_id) - idNum(b.ticket_id);
    })
    .slice(0, UP_NEXT_COUNT);
}

// ---------- load ----------
async function load(retried = false) {
  const key = currentKey();
  if (!key) { showGate(); return; }
  status('Loading…');
  try {
    const res = await fetch(`${API}?key=${encodeURIComponent(key)}`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { showGate('That key did not work. Check your dashboard link.'); status(''); return; }
    if (!res.ok || !body.ok) throw new Error(body.error || `Server answered ${res.status}`);
    // Marker rows left by removed calendar meetings never show on the page
    body.log = (body.log || []).filter((l) => l.source !== 'Removed' && (l.log_id || l.task));
    state.data = body;
    $('gate').hidden = true;
    render();
    status('');
  } catch (err) {
    console.error(err);
    if (!retried) { status('Busy for a moment, trying again…'); setTimeout(() => load(true), 8000); return; }
    status('Could not load the dashboard. Wait a minute, then press Refresh.');
  }
}
function showGate(msg) {
  $('gate').hidden = false;
  $('gate-error').textContent = msg || '';
  $('gate-key').focus();
}

// ---------- layout (desktop arrows and mobile fold) ----------
const layoutMode = (view) => (view === 'project' ? state.projLayout : state.layout);
function setLayout(mode) {
  if (route().view === 'project') state.projLayout = mode; else state.layout = mode;
  applyLayout(route().view);
}
function applyLayout(view) {
  const app = $('app');
  const mode = layoutMode(view);
  for (const m of ['split', 'next', 'projects']) app.classList.toggle(`mode-${m}`, mode === m);
  app.classList.toggle('next-folded', state.nextFolded);
  $('push-left').disabled = mode === 'projects';
  $('push-right').disabled = mode === 'next';
  $('strip-right').textContent = view === 'project' ? 'Project' : 'Projects';
  $('next-fold').setAttribute('aria-expanded', String(!state.nextFolded));
  $('next-fold').setAttribute('aria-label', state.nextFolded ? 'Expand Up next' : 'Collapse Up next');
}
// The arrows push the divider: left shrinks Up next, right widens it
const pushLeft = () => setLayout(layoutMode(route().view) === 'next' ? 'split' : 'projects');
const pushRight = () => setLayout(layoutMode(route().view) === 'projects' ? 'split' : 'next');

// ---------- routing ----------
function route() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('project/')) return { view: 'project', id: decodeURIComponent(h.slice(8)) };
  if (h === 'tasks' || h === 'log' || h === 'hours') return { view: h };
  return { view: 'home' };
}
function render() {
  if (!state.data) return;
  const r = route();
  $('hello').textContent = `Hi ${state.data.user.name}`;
  for (const v of ['home', 'tasks', 'log', 'hours', 'project']) $(`view-${v}`).hidden = v !== r.view;
  const wide = r.view === 'tasks' || r.view === 'log' || r.view === 'hours';
  $('next-section').hidden = wide;
  $('app').classList.toggle('full', wide);
  applyLayout(r.view);
  renderSessionBar();
  document.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === r.view ? 'page' : 'false'));
  renderNext();
  if (r.view === 'home') { renderChips(); renderProjects(); }
  if (r.view === 'tasks') renderTasks();
  if (r.view === 'log') renderLog();
  if (r.view === 'hours') renderHours();
  if (r.view === 'project') renderProjectPage(r.id);
}

// ---------- task rows (Up next, cards, project page) ----------
const byStatusThenId = (a, b) => (a.status === 'Backlog') - (b.status === 'Backlog') || idNum(a.ticket_id) - idNum(b.ticket_id);

function taskRow(t, opts = {}) {
  const kids = opts.withSubtasks ? subtasksOf(t) : [];
  const expanded = opts.expandAll || state.openTasks.has(t.ticket_id);
  const meta = [
    opts.showProject ? projectName(t.project) : null,
    // Up next stays lean: the color bar shows priority, the card shows project, due date and parent only
    opts.markSub ? null : `${t.priority || 'Low'} priority`,
    t.due_date ? `Due ${t.due_date}` : null,
    !opts.markSub && REPEATS.includes(t.repeat) ? `Repeats ${t.repeat.toLowerCase()}` : null,
    t.status !== 'Open' ? t.status : null,
    opts.markSub ? null : (t.category || null),
    opts.showAssignee ? (t.assignee || 'Unassigned') : null,
    t.blocked_by ? `Waiting on ${t.blocked_by}` : null,
  ].filter(Boolean);
  const parent = opts.markSub && t.parent_ticket ? (t._parent || state.data.tickets.find((x) => x.ticket_id === t.parent_ticket)) : null;
  const li = el('li', { class: 'task', 'data-priority': t._priority || t.priority || 'Low' },
    el('input', { type: 'checkbox', class: 'tick', 'aria-label': `Check off ${t.task}`, onchange: (e) => { e.target.checked = false; openComplete(t); } }),
    el('div', {},
      el('button', { type: 'button', class: 'task-open', onclick: () => openTask({ task: t }) },
        el('span', { class: 'task-id' }, t.ticket_id), ' ', el('span', { class: 'task-name' }, t.task)),
      el('span', { class: 'task-meta' }, meta.map((m) => el('span', {}, m))),
      parent ? el('span', { class: 'task-parent' }, 'Subtask of ',
        el('button', { type: 'button', class: 'link', onclick: () => openTask({ task: parent }) }, `${parent.ticket_id} ${parent.task}`)) : null,
      kids.length && !opts.expandAll ? el('button', {
        type: 'button', class: 'link sub-toggle', 'aria-expanded': String(expanded),
        onclick: () => { if (expanded) state.openTasks.delete(t.ticket_id); else state.openTasks.add(t.ticket_id); render(); },
      }, `${expanded ? 'Hide' : 'Show'} ${plural(kids.length, 'subtask')}`) : null,
    ),
  );
  if (kids.length && expanded) {
    li.append(el('ul', { class: 'task-list sub' }, kids.sort(byStatusThenId).map((k) => taskRow(k, { showAssignee: true }))));
  }
  return li;
}

function renderNext() {
  const items = upNext();
  $('next-list').replaceChildren(...(items.length
    ? items.map((t) => taskRow(t, { showProject: true, markSub: true }))
    : [el('li', { class: 'next-empty' }, 'Nothing is assigned to you right now. Use New task to add one.')]));
}

// ---------- dashboard ----------
function renderChips() {
  const d = state.data;
  const make = (value, label) => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(state.client === value),
    onclick: () => { state.client = value; render(); },
  }, label);
  $('client-chips').replaceChildren(make('all', 'All clients'), ...d.clients.map((c) => make(c.client, c.client)));
}

function sortProjects(list) {
  return list.sort((a, b) => statusRank(a.status) - statusRank(b.status)
    || isSecondary(a) - isSecondary(b)
    || tasksOfProject(b.project_id).length - tasksOfProject(a.project_id).length
    || a.display_name.localeCompare(b.display_name));
}

function renderProjects() {
  const d = state.data;
  const wrap = $('project-groups');
  wrap.replaceChildren();
  if (new URLSearchParams(location.search).get('preview') === 'maintenance') wrap.append(...maintenancePreview());
  if (state.client !== 'all') {
    const c = d.clients.find((x) => x.client === state.client);
    if (c) wrap.append(el('p', { class: 'client-line' }, el('strong', {}, c.company_name || c.client), c.primary_contacts ? `Contacts: ${c.primary_contacts}` : null));
  }
  const projects = sortProjects(d.projects
    .filter((p) => state.client === 'all' || p.client === state.client)
    .filter((p) => state.showClosed || !CLOSED.includes(p.status)));
  if (!projects.length) wrap.append(el('p', { class: 'meter-empty' }, 'No open projects here. Tick "Show done and canceled" to see the rest.'));
  for (const p of projects) wrap.append(projectCard(p));
}

function taskCounts(projectId) {
  const tasks = tasksOfProject(projectId);
  const ids = new Set(tasks.map((t) => t.ticket_id));
  const top = tasks.filter((t) => isTopLevel(t, ids)).length;
  const sub = tasks.length - top;
  if (!tasks.length) return '';
  return sub ? `${plural(sub, 'open subtask')} from ${plural(top, 'open task')}` : plural(top, 'open task');
}

// The status bubble doubles as a dropdown so status can change right from the card
function statusPicker(p) {
  if (String(p.project_id).startsWith('preview')) return el('span', { class: 'project-status', 'data-status': p.status }, p.status);
  return el('select', {
    class: 'project-status status-select', 'data-status': p.status, 'aria-label': `Status for ${p.display_name}`,
    onchange: async (e) => {
      try {
        status('Saving…');
        await post('project', { project_id: p.project_id, status: e.target.value });
        await load();
        status('Status saved');
        setTimeout(() => status(''), 1500);
      } catch (ex) { status(`Could not save: ${ex.message}`); e.target.value = p.status; }
    },
  }, PROJECT_STATUSES.map((s) => el('option', { value: s, selected: s === p.status }, s)));
}

function projectCard(p) {
  const open = state.openCards.has(p.project_id);
  const tasks = tasksOfProject(p.project_id);
  const ids = new Set(tasks.map((t) => t.ticket_id));
  const top = tasks.filter((t) => isTopLevel(t, ids)).sort(byStatusThenId);
  const facts = [taskCounts(p.project_id), hoursText(p), p.members ? `Team: ${p.members}` : ''].filter(Boolean);
  const isPreview = String(p.project_id).startsWith('preview');
  return el('article', { class: `project${CLOSED.includes(p.status) ? ' closed' : ''}` },
    el('h3', {}, isPreview ? p.display_name : el('a', { href: `#project/${encodeURIComponent(p.project_id)}`, class: 'project-link' }, p.display_name)),
    statusPicker(p),
    el('div', { class: 'project-body' },
      p.notes ? el('p', { class: 'project-note' }, p.notes) : null,
      p.status === 'Maintenance' ? maintenanceRow(p) : meter(p),
      facts.length ? el('div', { class: 'project-facts' }, facts.map((f) => el('span', {}, f))) : null,
      split(p.tools).length ? el('div', { class: 'tags', 'aria-label': 'Tools' }, split(p.tools).map((t) => el('span', { class: 'tag' }, t))) : null,
      isPreview ? null : el('div', { class: 'card-actions' },
        el('button', { type: 'button', class: 'link', 'aria-expanded': String(open), onclick: () => {
          if (open) state.openCards.delete(p.project_id); else state.openCards.add(p.project_id);
          render();
        } }, open ? 'Hide tasks' : `Show tasks (${top.length})`),
        el('button', { type: 'button', class: 'link', onclick: () => openTask({ project: p.project_id }) }, 'Add task'),
        el('a', { class: 'link', href: `#project/${encodeURIComponent(p.project_id)}` }, 'Open project'),
      ),
      open ? (top.length ? el('ul', { class: 'task-list' }, top.map((t) => taskRow(t, { withSubtasks: true, showAssignee: true })))
        : el('p', { class: 'meter-empty' }, 'No open tasks on this project.')) : null,
    ),
  );
}

// One block per milestone; each block fills by its own tasks and locks full when the milestone is Done.
function meter(p) {
  if (p.segments && p.segments.length) {
    const current = p.segments.find((s) => s.status !== 'Done');
    return el('div', { class: 'meter-wrap' },
      el('div', { class: 'meter', role: 'img', 'aria-label': `${p.progress}% complete across ${p.segments.length} milestones` },
        p.segments.map((s) => el('div', {
          class: `seg${s.status === 'Done' ? ' done' : ''}`,
          style: `flex: ${s.share} 1 0`, title: `${s.milestone}: ${Math.round(s.fill * 100)}%`,
        }, el('div', { class: 'seg-fill', style: `width: ${Math.round(s.fill * 100)}%` }))),
      ),
      el('div', { class: 'meter-labels' },
        el('span', {}, current ? `Now: ${current.milestone}` : 'All milestones done'),
        el('span', { class: 'meter-pct' }, `${p.progress}%`),
      ),
    );
  }
  if (p.progress !== null && p.progress !== undefined) {
    return el('div', { class: 'meter-wrap' },
      el('div', { class: 'meter', role: 'img', 'aria-label': `${p.progress}% complete` },
        el('div', { class: 'seg', style: 'flex: 1 1 0' }, el('div', { class: 'seg-fill', style: `width: ${p.progress}%` }))),
      el('div', { class: 'meter-labels' }, el('span', {}, 'Set by hand'), el('span', { class: 'meter-pct' }, `${p.progress}%`)),
    );
  }
  return el('p', { class: 'meter-empty' }, 'No milestones yet');
}

// ---------- maintenance ----------
function maintenanceLoad(p) {
  const hrs = Number(p.weekly_hours);
  if (hrs > 0) return Math.min(1, hrs / 40);
  return Math.min(1, (p.open_tickets || 0) / 10);
}
const STAGES = [
  [0.5, 'heavy', 'Needs daily attention', 'Lots of open work. Plan time for it most days.'],
  [0.25, 'steady', 'A few check-ins per week', 'Several open tasks. Check in a few times a week.'],
  [0.1, 'light', 'Weekly check-in', 'A handful of tasks. One check-in a week covers it.'],
  [0, 'cruise', 'Low upkeep', 'Little to no open work. Check in as needed.'],
];
const stageFor = (load) => STAGES.find(([min]) => load >= min);
function gauge(load) {
  const [, stage, label] = stageFor(load);
  return el('div', { class: 'gauge', 'data-stage': stage, role: 'img', 'aria-label': `Maintenance load ${Math.round(load * 100)}%, ${label}` },
    el('span', {}, `${Math.round(load * 100)}%`));
}
function maintenanceRow(p) {
  const load = maintenanceLoad(p);
  const [, , label, detail] = stageFor(load);
  const last = p.segments && p.segments.length ? p.segments[p.segments.length - 1].milestone : '';
  // No milestones means an ongoing catch-all project (like WIPP General), not a finished build
  const ongoing = !last;
  const phase = last ? last.split(' - ')[0] : '';
  return el('div', { class: 'maint' },
    el('div', { class: 'maint-done' },
      el('div', { class: 'maint-arrow' }, el('span', {}, ongoing ? 'Ongoing' : 'Complete')),
      el('p', { class: 'maint-caption' }, ongoing ? 'Ongoing, no milestones' : `${phase} complete, in maintenance mode`)),
    el('div', { class: 'maint-gauge' }, gauge(load), el('div', { class: 'gauge-text' }, el('strong', {}, label), detail)),
  );
}
function maintenancePreview() {
  const base = projectOf('P-001') || { segments: [] };
  return [0.6, 0.35, 0.15, 0.05].map((load) => projectCard({
    ...base, project_id: `preview-${load}`, display_name: `Preview - ${stageFor(load)[2]}`,
    status: 'Maintenance', notes: 'Sample card, only shown with the preview link', weekly_hours: load * 40,
    open_tickets: 0, tools: '', members: '',
  }));
}

// ---------- project page ----------
function renderProjectPage(id) {
  const d = state.data;
  const view = $('view-project');
  const p = projectOf(id);
  if (!p) { view.replaceChildren(el('p', {}, 'That project was not found. ', el('a', { href: '#' }, 'Back to the dashboard'))); return; }
  const c = clientOf(p);
  const tasks = tasksOfProject(id);
  const ids = new Set(tasks.map((t) => t.ticket_id));
  const top = tasks.filter((t) => isTopLevel(t, ids)).sort(byStatusThenId);
  const milestones = d.milestones.filter((m) => m.project_id === id);
  const log = d.log.filter((l) => l.project === id);
  const fact = (label, value) => (value ? [el('dt', {}, label), el('dd', {}, value)] : []);
  const dates = [p.start_date, p.end_date].filter(Boolean).join(' to ');
  const hours = [hoursText(p) || '0 hours logged', p.weekly_hours ? `${p.weekly_hours} per week` : ''].filter(Boolean).join(', ');

  view.replaceChildren(
    el('a', { href: '#', class: 'link back' }, 'Back to the dashboard'),
    el('div', { class: 'page-head' },
      el('h2', {}, p.display_name),
      statusPicker(p)),
    p.notes ? el('p', { class: 'page-note' }, p.notes) : null,
    el('div', { class: 'page-grid' },
      el('div', { class: 'panel' },
        el('h3', {}, 'Progress'),
        p.status === 'Maintenance' ? maintenanceRow(p) : meter(p),
        milestones.length ? el('ol', { class: 'milestones' }, milestones.map((m) => el('li', { 'data-status': m.status },
          el('strong', {}, m.milestone), el('span', {}, [m.status, m.target_date ? `target ${m.target_date}` : ''].filter(Boolean).join(', '))))) : null),
      el('div', { class: 'panel' },
        el('h3', {}, 'Details'),
        el('dl', { class: 'facts' },
          fact('Client', [c.company_name || p.client, c.primary_contacts ? ` (${c.primary_contacts})` : ''].join('')),
          fact('Time type', p.time_type || ''),
          fact('Owner', p.owner), fact('Team', p.members), fact('Timeframe', dates), fact('Hours', hours),
          fact('Categories', p.categories), fact('Tools', p.tools)),
        el('button', { type: 'button', class: 'link', onclick: () => openProject(p) }, 'Edit project')),
      el('div', { class: 'panel' },
        el('h3', {}, 'Links'),
        parseLinks(p.links).length
          ? el('ul', { class: 'links' }, parseLinks(p.links).map((l) => el('li', {}, el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.name))))
          : el('p', { class: 'meter-empty' }, 'No links yet. Add the project folder and docs with Edit project.')),
    ),
    el('div', { class: 'panel' },
      el('div', { class: 'projects-head' },
        el('h3', {}, `Tasks${tasks.length ? ` (${taskCounts(id)})` : ''}`),
        el('button', { type: 'button', class: 'link', onclick: () => openTask({ project: id }) }, 'Add task')),
      top.length ? el('ul', { class: 'task-list' }, top.map((t) => taskRow(t, { withSubtasks: true, expandAll: true, showAssignee: true })))
        : el('p', { class: 'meter-empty' }, 'No open tasks on this project.')),
    el('div', { class: 'panel' },
      el('h3', {}, 'Log'),
      log.length ? logList(log, false) : el('p', { class: 'meter-empty' }, 'Checked-off tasks for this project will show up here.')),
  );
}

// ---------- all tasks (list and ticketing mode) ----------
const COLUMNS = [
  ['ticket_id', 'ID', (t) => idNum(t.ticket_id)],
  ['task', 'Task', (t) => t.task.toLowerCase()],
  ['project', 'Project', (t) => projectName(t.project)],
  ['category', 'Category', (t) => (t.category || '~').toLowerCase()],
  ['assignee', 'Assignee', (t) => t.assignee || '~'],
  ['priority', 'Priority', (t) => PRIORITY_RANK[t.priority] ?? 3],
  ['status', 'Status', (t) => TASK_STATUS_RANK[t.status] ?? 9],
  ['milestone_id', 'Milestone', (t) => t.milestone_id || '~'],
  ['due_date', 'Due', (t) => toIso(t.due_date) || '9999'],
];

async function quickSave(t, key, value) {
  try {
    status('Saving…');
    await post('ticket/update', { ticket_id: t.ticket_id, [key]: value });
    await load();
    status('Saved');
    setTimeout(() => status(''), 1500);
  } catch (ex) { status(`Could not save: ${ex.message}`); }
}

function renderTasks() {
  const d = state.data;
  const f = state.filter;
  const sel = (key, label, options) => field(label, el('select', {
    onchange: (e) => { f[key] = e.target.value; render(); },
  }, options.map(([v, l]) => el('option', { value: v, selected: f[key] === v }, l))));
  const cats = [...new Set(d.tickets.map((t) => t.category).filter(Boolean))].sort();
  $('task-filters').replaceChildren(
    sel('project', 'Project', [['', 'All projects'], ...sortProjects(d.projects.filter((p) => tasksOfProject(p.project_id).length)).map((p) => [p.project_id, p.display_name])]),
    sel('assignee', 'Assignee', [['', 'Everyone'], ['-', 'Unassigned'], ...d.people.map((n) => [n, n])]),
    sel('category', 'Category', [['', 'All categories'], ...cats.map((c) => [c, c])]),
  );
  $('ticketing').checked = state.ticketing;

  const ids = openIds();
  const match = (t) => (!f.project || t.project === f.project)
    && (!f.assignee || (f.assignee === '-' ? !t.assignee : split(t.assignee).includes(f.assignee)))
    && (!f.category || t.category === f.category);
  const tops = d.tickets.filter((t) => isTopLevel(t, ids)).filter((t) => match(t) || subtasksOf(t).some(match));
  const [, , keyFn] = COLUMNS.find(([k]) => k === state.sort.key);
  const cmp = (a, b) => {
    const x = keyFn(a); const y = keyFn(b);
    return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir || idNum(a.ticket_id) - idNum(b.ticket_id);
  };
  const columns = state.ticketing ? COLUMNS : COLUMNS.filter(([k]) => k !== 'milestone_id');

  const head = el('tr', {}, columns.map(([k, label]) => {
    const active = state.sort.key === k;
    return el('th', { scope: 'col', 'aria-sort': active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none' },
      el('button', { type: 'button', class: 'sort', onclick: () => {
        state.sort = { key: k, dir: active ? -state.sort.dir : 1 };
        render();
      } }, label, active ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : ''));
  }), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Check off')));

  const pick = (t, key, options, label) => el('select', {
    class: 'inline-select', 'aria-label': `${label} for ${t.ticket_id}`,
    onchange: (e) => quickSave(t, key, e.target.value),
  }, options.map(([v, l]) => el('option', { value: v, selected: String(t[key] || '') === String(v) }, l)));

  const row = (t, isSub) => {
    const kids = isSub ? [] : subtasksOf(t);
    const open = state.openTasks.has(t.ticket_id);
    const p = projectOf(t.project) || {};
    const cells = {
      ticket_id: el('td', { class: 'id-cell' }, t.ticket_id),
      task: el('td', { class: 'task-cell' },
        el('button', { type: 'button', class: 'task-open', onclick: () => openTask({ task: t }) }, el('span', { class: 'task-name' }, t.task)),
        kids.length ? el('button', { type: 'button', class: 'link sub-toggle', 'aria-expanded': String(open), onclick: () => {
          if (open) state.openTasks.delete(t.ticket_id); else state.openTasks.add(t.ticket_id);
          render();
        } }, `${open ? 'Hide' : 'Show'} ${plural(kids.length, 'subtask')}`) : null),
      project: el('td', {}, state.ticketing
        ? pick(t, 'project', sortProjects([...d.projects]).map((x) => [x.project_id, x.display_name]), 'Project')
        : projectName(t.project)),
      category: el('td', {}, state.ticketing
        ? [el('input', { class: 'inline-select', value: t.category || '', list: `cats-${t.ticket_id}`, 'aria-label': `Category for ${t.ticket_id}`,
          onchange: (e) => quickSave(t, 'category', e.target.value) }),
        el('datalist', { id: `cats-${t.ticket_id}` }, split(p.categories).map((c) => el('option', { value: c })))]
        : (t.category || '')),
      assignee: el('td', {}, state.ticketing ? pick(t, 'assignee', [['', 'Unassigned'], ...d.people.map((n) => [n, n])], 'Assignee') : (t.assignee || 'Unassigned')),
      priority: el('td', {}, state.ticketing ? pick(t, 'priority', [['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']], 'Priority')
        : el('span', { class: 'pill', 'data-priority': t.priority }, t.priority || 'Low')),
      status: el('td', {}, state.ticketing ? pick(t, 'status', TASK_STATUSES.map((s) => [s, s]), 'Status') : t.status),
      milestone_id: el('td', {}, pick(t, 'milestone_id', [['', 'None'], ...d.milestones.filter((m) => m.project_id === t.project).map((m) => [m.milestone_id, m.milestone])], 'Milestone')),
      due_date: el('td', { class: 'nowrap' }, t.due_date || ''),
    };
    return el('tr', { class: isSub ? 'sub-row' : '' },
      columns.map(([k]) => cells[k]),
      el('td', {}, el('input', { type: 'checkbox', class: 'tick', 'aria-label': `Check off ${t.task}`, onchange: (e) => { e.target.checked = false; openComplete(t); } })));
  };

  const rows = [];
  for (const t of tops.sort(cmp)) {
    rows.push(row(t, false));
    if (state.openTasks.has(t.ticket_id)) for (const k of subtasksOf(t).sort(cmp)) rows.push(row(k, true));
  }
  $('task-table').classList.toggle('ticketing', state.ticketing);
  $('task-table').replaceChildren(rows.length
    ? el('table', { class: 'tasks-table' }, el('thead', {}, head), el('tbody', {}, rows))
    : el('p', { class: 'meter-empty' }, 'No open tasks match these filters.'));
}

// ---------- log ----------
function logList(entries, showProject) {
  return el('ol', { class: 'log-list' }, entries.map((l) => el('li', { class: 'log-item' },
    el('div', { class: 'log-head' },
      el('strong', {}, [l.ticket_id, l.task].filter(Boolean).join(' ')),
      el('span', {}, [l.completed_at, l.completed_by, l.actual_hours ? `${l.actual_hours} h` : ''].filter(Boolean).join(', '))),
    el('div', { class: 'type-chips' },
      el('span', { class: 'type-chip', 'data-type': typeOf(l) }, typeOf(l)),
      l.source === 'Calendar' || l.source === 'Extra' ? el('span', { class: 'type-chip' }, l.source === 'Calendar' ? 'From calendar' : 'Session extra') : null),
    showProject ? el('p', { class: 'log-project' }, projectName(l.project)) : null,
    l.completed_by === state.data.user.name ? el('button', { type: 'button', class: 'link log-edit', onclick: () => openLogEdit(l) }, 'Edit') : null,
    el('dl', { class: 'log-notes' },
      l.what_was_done ? [el('dt', {}, 'Done'), el('dd', {}, l.what_was_done)] : null,
      l.what_changed ? [el('dt', {}, 'Changed or found'), el('dd', {}, l.what_changed)] : null,
      l.next_steps ? [el('dt', {}, 'Next'), el('dd', {}, l.next_steps)] : null),
  )));
}
function renderLog() {
  const d = state.data;
  const projects = sortProjects(d.projects.filter((p) => d.log.some((l) => l.project === p.project_id)));
  $('log-filters').replaceChildren(field('Project', el('select', { onchange: (e) => { state.logProject = e.target.value; render(); } },
    [['', 'All projects'], ...projects.map((p) => [p.project_id, p.display_name])].map(([v, l]) => el('option', { value: v, selected: state.logProject === v }, l)))));
  const entries = d.log.filter((l) => !state.logProject || l.project === state.logProject);
  $('log-list').replaceChildren(entries.length ? logList(entries, true) : el('p', { class: 'meter-empty' }, 'Checked-off tasks show up here with your notes.'));
}

// ---------- dialogs ----------
function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('span', { class: 'field-hint' }, hint) : null);
}
function select(name, options, value) {
  return el('select', { name }, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value ?? '') }, l)));
}
function showDialog(title, formKids, onSave, saveLabel, after, extraButtons = []) {
  const dlg = $('dialog');
  const err = el('p', { class: 'form-error', role: 'alert' });
  const form = el('form', { method: 'dialog', class: 'form' },
    el('h2', {}, title), ...formKids, err,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, 'Cancel'),
      extraButtons.map((b) => el('button', { type: 'submit', class: 'secondary', value: b.value }, b.label)),
      el('button', { type: 'submit', class: 'primary' }, saveLabel)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btns = form.querySelectorAll('.form-actions button[type="submit"]');
    btns.forEach((b) => { b.disabled = true; }); err.textContent = '';
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      await onSave(values, form, e.submitter);
      dlg.close();
      await load();
      if (after) after();
    } catch (ex) { err.textContent = ex.message; } finally { btns.forEach((b) => { b.disabled = false; }); }
  });
  dlg.replaceChildren(form);
  dlg.showModal();
  const first = form.querySelector('input, textarea, select');
  if (first) first.focus();
  return form;
}

// Close the open dialog before opening another one (a dialog can't be opened twice)
const swapTo = (fn) => { $('dialog').close(); fn(); };
function openTask({ task, project, parent }) {
  const d = state.data;
  const t = task || {};
  const projId = t.project || project || '';
  const p = projectOf(projId) || {};
  const people = [['', 'Unassigned'], ...d.people.map((n) => [n, n])];
  const projects = [['', 'Choose a project'], ...sortProjects([...d.projects]).map((x) => [x.project_id, x.display_name])];
  const msOpts = (id) => [['', 'None'], ...d.milestones.filter((m) => m.project_id === id).map((m) => [m.milestone_id, m.milestone])];
  const parentOpts = (id) => [['', 'None (main task)'], ...d.tickets.filter((x) => x.project === id && x.ticket_id !== t.ticket_id && !x.parent_ticket).map((x) => [x.ticket_id, `${x.ticket_id} ${x.task}`])];
  const cats = el('datalist', { id: 'cat-list' }, split(p.categories).map((c) => el('option', { value: c })));
  const typeOpts = (id) => [['', `Project default (${(projectOf(id) || {}).time_type || 'Billable'})`], ...TIME_TYPES.map((x) => [x, x])];

  const kids = task ? sortSubs(subtasksOf(t)) : [];
  const parentT = t.parent_ticket ? d.tickets.find((x) => x.ticket_id === t.parent_ticket) : null;
  const relations = task ? el('div', { class: 'subtask-box' },
    parentT ? el('p', { class: 'form-sub' }, 'Subtask of ', el('button', { type: 'button', class: 'link', onclick: () => swapTo(() => openTask({ task: parentT })) }, `${parentT.ticket_id} ${parentT.task}`)) : null,
    el('strong', {}, kids.length ? `${plural(kids.length, 'open subtask')}` : 'No open subtasks'),
    kids.length ? el('ul', {}, kids.map((k) => el('li', {}, el('button', { type: 'button', class: 'link', onclick: () => swapTo(() => openTask({ task: k })) }, `${k.ticket_id} ${k.task}`), k.status !== 'Open' ? ` (${k.status})` : ''))) : null,
    el('button', { type: 'button', class: 'link', onclick: () => swapTo(() => openTask({ project: t.project, parent: t.ticket_id })) }, 'Add a subtask')) : null;
  const form = showDialog(task ? `Edit ${t.ticket_id}` : 'New task', [
    relations,
    field('Task', el('input', { name: 'task', required: true, value: t.task || '' })),
    field('Description', el('textarea', { name: 'description', rows: 2 }, t.description || '')),
    el('div', { class: 'row' },
      field('Project', select('project', projects, projId)),
      field('Category', el('input', { name: 'category', list: 'cat-list', value: t.category || '' }), 'Like Xano, Softr, G Sheets')),
    el('div', { class: 'row' },
      field('Assignee', select('assignee', people, t.assignee ?? (task ? '' : d.user.name))),
      field('Priority', select('priority', [['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']], t.priority || 'Low')),
      field('Status', select('status', TASK_STATUSES.map((s) => [s, s]), t.status || 'Open'))),
    el('div', { class: 'row' },
      field('Due date', el('input', { name: 'due_date', type: 'date', value: toIso(t.due_date) })),
      field('Estimated hours', el('input', { name: 'est_hours', type: 'number', min: 0, step: 0.25, value: t.est_hours || '' }))),
    el('div', { class: 'row' },
      field('Milestone', select('milestone_id', msOpts(projId), t.milestone_id)),
      field('Subtask of', select('parent_ticket', parentOpts(projId), t.parent_ticket || parent || ''))),
    el('div', { class: 'row' },
      field('Time type', select('time_type', typeOpts(projId), t.time_type || ''), 'Switch to Internal for setup, admin or anything not billed'),
      field('Blocked by', el('input', { name: 'blocked_by', value: t.blocked_by || '' }), 'Task IDs, like T-004')),
    field('Repeats', select('repeat', [['', 'Does not repeat'], ...REPEATS.map((x) => [x, x])], t.repeat || ''),
      'Checking off a repeating task logs it, then reopens it with the next due date'),
    field('Notes', el('textarea', { name: 'notes', rows: 2 }, t.notes || '')),
    cats,
  ], async (v) => {
    if (task) await post('ticket/update', { ticket_id: t.ticket_id, ...v });
    else {
      const out = await post('ticket', v);
      const newId = out.ticket_id || (out.ticket || {}).ticket_id;
      if (v.repeat && newId) await post('ticket/update', { ticket_id: newId, repeat: v.repeat });
    }
    status(task ? 'Task saved' : 'Task added');
  }, task ? 'Save task' : 'Add task');

  // Picking a different project refreshes its milestones, possible parent tasks and categories
  form.elements.project.addEventListener('change', (e) => {
    const id = e.target.value;
    const fill = (s, opts) => s.replaceChildren(...opts.map(([v, l]) => el('option', { value: v }, l)));
    fill(form.elements.milestone_id, msOpts(id));
    fill(form.elements.parent_ticket, parentOpts(id));
    fill(form.elements.time_type, typeOpts(id));
    $('cat-list').replaceChildren(...split((projectOf(id) || {}).categories).map((c) => el('option', { value: c })));
  });
}


// Time picker: 0, 5 and 10 minutes for quick tasks, then 15-minute steps. Saves hours to 2 decimals.
function timeStepper(name, hours) {
  let mins = hours !== undefined && hours !== '' && hours !== null ? Math.round(Number(hours) * 60) : 15;
  const hidden = el('input', { type: 'hidden', name });
  const label = el('output', { class: 'stepper-value', 'aria-live': 'polite' });
  const show = () => {
    const h = Math.floor(mins / 60); const m = mins % 60;
    label.textContent = [h ? `${h} h` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' ');
    hidden.value = String(Math.round((mins / 60) * 100) / 100);
  };
  const down = () => { mins = mins <= 15 ? Math.max(0, mins - 5) : Math.ceil(mins / 15) * 15 - 15; show(); };
  const up = () => { mins = mins < 15 ? mins + 5 : Math.floor(mins / 15) * 15 + 15; show(); };
  show();
  return el('div', { class: 'stepper' },
    el('button', { type: 'button', class: 'step-btn', 'aria-label': 'Less time', onclick: down }, '−'),
    label,
    el('button', { type: 'button', class: 'step-btn', 'aria-label': 'More time', onclick: up }, '+'),
    hidden);
}

// Summary box that starts as "done": clicking in clears it, leaving it empty puts "done" back
function doneBox() {
  const box = el('textarea', { name: 'what_was_done', rows: 4, required: true }, 'done');
  box.addEventListener('focus', () => { if (box.value.trim() === 'done') box.value = ''; });
  box.addEventListener('blur', () => { if (!box.value.trim()) box.value = 'done'; });
  return box;
}
const openDescendants = (t) => subtasksOf(t).flatMap((k) => [...openDescendants(k), k]);
function openComplete(t) {
  const kids = openDescendants(t);
  const parent = t.parent_ticket ? state.data.tickets.find((x) => x.ticket_id === t.parent_ticket) : null;
  const lastSub = parent && subtasksOf(parent).every((k) => k.ticket_id === t.ticket_id);
  const repeats = REPEATS.includes(t.repeat);
  const live = liveSession();
  showDialog('Check off task', [
    el('p', { class: 'form-sub' }, `${t.ticket_id} ${t.task}`),
    repeats ? el('p', { class: 'form-warn' }, `This repeats ${t.repeat.toLowerCase()}. Checking it off saves this check-in to the Log and moves it to ${shortDate(nextDue(t))}.`) : null,
    kids.length ? el('p', { class: 'form-warn' }, `This also checks off its ${plural(kids.length, 'open subtask')} (${kids.map((k) => k.ticket_id).join(', ')}) with the note "Done with ${t.ticket_id}" and 0 min.`) : null,
    field('Summary or findings', doneBox(), 'Leave it as "done" or click in to write your own'),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Estimated time spent on task'), timeStepper('actual_hours', repeats ? undefined : t.actual_hours)),
  ], async (v) => {
    const sid = live ? { session_id: live.session_id } : {};
    for (const k of kids) await post('ticket/update', { ticket_id: k.ticket_id, complete: { what_was_done: `Done with ${t.ticket_id}`, actual_hours: 0, ...sid } });
    const out = await post('ticket/update', { ticket_id: t.ticket_id, complete: { ...v, ...sid } });
    status(out.reopened ? `Logged. Next one is due ${shortDate(out.reopened)}` : 'Checked off and saved to the log');
  }, 'Check off', lastSub ? () => openParentPrompt(parent.ticket_id) : null);
}

// After the last subtask is checked off, offer to check off its parent
function openParentPrompt(id) {
  const parent = state.data.tickets.find((x) => x.ticket_id === id);
  if (!parent) return;
  const dlg = $('dialog');
  dlg.replaceChildren(el('div', { class: 'form' },
    el('h2', {}, 'All subtasks complete'),
    el('p', {}, `Every subtask of ${parent.ticket_id} ${parent.task} is done. Mark it complete too?`),
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, 'Not yet'),
      el('button', { type: 'button', class: 'primary', onclick: () => { dlg.close(); openComplete(parent); } }, 'Check off parent'))));
  dlg.showModal();
}

// Edit a checked-off Log entry: summary, time spent and time type
function openLogEdit(l) {
  const p = projectOf(l.project) || {};
  const loose = !l.ticket_id;
  const removable = l.source === 'Extra' || l.source === 'Calendar';
  showDialog('Edit log entry', [
    loose ? field('What was it', el('input', { name: 'task', value: l.task || '' }))
      : el('p', { class: 'form-sub' }, [l.ticket_id, l.task].filter(Boolean).join(' ')),
    loose ? field('Project', select('project', sortProjects([...state.data.projects]).map((x) => [x.project_id, x.display_name]), l.project)) : null,
    removable ? el('button', { type: 'button', class: 'link remove', onclick: async () => {
      if (!confirmInline(`Remove ${l.task} from the Log?`)) return;
      try { await post('session', { action: 'log_delete', log_id: l.log_id }); $('dialog').close(); await load(); status('Entry removed'); } catch (ex) { status(`Could not remove: ${ex.message}`); }
    } }, 'Remove this entry') : null,
    field('Summary or findings', el('textarea', { name: 'what_was_done', rows: 4 }, l.what_was_done || '')),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Time spent'), timeStepper('actual_hours', l.actual_hours === '' ? 0 : l.actual_hours)),
    field('Time type', select('time_type', [['', `Project default (${p.time_type || 'Billable'})`], ...TIME_TYPES.map((x) => [x, x])], l.time_type || '')),
  ], async (v) => {
    await post('session', { action: 'log_edit', log_id: l.log_id, ...v });
    if (l.ticket_id) await post('ticket/update', { ticket_id: l.ticket_id, actual_hours: v.actual_hours }).catch(() => {});
    status('Log entry saved');
  }, 'Save entry');
}

// Small in-page confirm (browser confirm boxes are avoided); second click within 4 seconds confirms
function confirmInline(msg) {
  const now = Date.now();
  if (state.confirmMsg === msg && now - state.confirmAt < 4000) { state.confirmMsg = ''; return true; }
  state.confirmMsg = msg; state.confirmAt = now;
  status(`${msg} Click again to confirm`);
  return false;
}

// Named links: a nickname plus the URL, one row each. The first row is the project folder.
function linkEditor(text) {
  const existing = parseLinks(text);
  const list = el('div', { class: 'link-rows' });
  const addRow = (l = {}, placeholder = 'Link name') => list.append(el('div', { class: 'row link-row' },
    el('input', { 'data-k': 'name', name: 'link_name', placeholder, value: l.name && l.name !== l.url ? l.name : '', 'aria-label': 'Link name' }),
    el('input', { 'data-k': 'url', name: 'link_url', type: 'url', placeholder: 'https://', value: l.url || '', 'aria-label': 'Link URL' })));
  if (existing.length) existing.forEach((l) => addRow(l)); else addRow({}, 'Project folder');
  return el('fieldset', { class: 'field' }, el('legend', { class: 'field-label' }, 'Links'),
    el('span', { class: 'field-hint' }, 'Give each link a short name, like L\'GATO project folder or Master documentation'),
    list,
    el('button', { type: 'button', class: 'link', onclick: () => addRow() }, 'Add another link'));
}

function openProject(p) {
  const d = state.data;
  const x = p || {};
  const memberSet = new Set(split(x.members));
  showDialog(p ? `Edit ${x.display_name}` : 'New project', [
    el('div', { class: 'row' },
      field('Client', select('client', d.clients.map((c) => [c.client, c.client]), x.client || '')),
      field('Project name', el('input', { name: 'project', required: true, value: x.project || '' }))),
    el('div', { class: 'row' },
      field('Status', select('status', PROJECT_STATUSES.map((s) => [s, s]), x.status || 'Active')),
      field('Owner', select('owner', d.people.map((n) => [n, n]), x.owner || d.user.name))),
    field('Time type', select('time_type', TIME_TYPES.map((t) => [t, t]), x.time_type || 'Billable'),
      'Default for this project\'s tasks. Any task can switch to another type'),
    el('fieldset', { class: 'field members' }, el('legend', { class: 'field-label' }, 'Members'),
      d.people.map((n) => el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'm', value: n, checked: p ? memberSet.has(n) : n === d.user.name }), n))),
    field('Tools', el('input', { name: 'tools', value: x.tools || '' }), 'Comma separated, like n8n, G Sheets, Claude TBD'),
    field('Categories', el('input', { name: 'categories', value: x.categories || '' }), 'Parts tasks get sorted into, like Softr front end, Xano back end'),
    el('div', { class: 'row' },
      field('Start date', el('input', { name: 'start_date', type: 'date', value: toIso(x.start_date) })),
      field('End date', el('input', { name: 'end_date', type: 'date', value: toIso(x.end_date) }))),
    el('div', { class: 'row' },
      field('Allocated hours', el('input', { name: 'allocated_hours', type: 'number', min: 0, step: 0.5, value: x.allocated_hours || '' })),
      field('Weekly hours', el('input', { name: 'weekly_hours', type: 'number', min: 0, step: 0.5, value: x.weekly_hours || '' }))),
    field('Notes', el('textarea', { name: 'notes', rows: 2 }, x.notes || '')),
    linkEditor(x.links),
  ], async (v, form) => {
    const links = [...form.querySelectorAll('.link-row')].map((r) => {
      const name = r.querySelector('[data-k="name"]').value.trim().replace(/\|/g, '-');
      const url = r.querySelector('[data-k="url"]').value.trim();
      return url ? `${name || url} | ${url}` : '';
    }).filter(Boolean).join('\n');
    v.links = links;
    delete v.link_name; delete v.link_url;
    const members = [...form.querySelectorAll('input[name="m"]:checked')].map((i) => i.value).join(', ');
    delete v.m;
    await post('project', { ...(p ? { project_id: x.project_id } : {}), ...v, members });
    status(p ? 'Project saved' : 'Project added');
  }, p ? 'Save project' : 'Add project');
}

// ---------- sessions ----------
const pad2 = (n) => String(n).padStart(2, '0');
const nowHM = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const hmToMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function clock(t) {
  const m = hmToMin(t);
  if (m === null) return t || '';
  const h = Math.floor(m / 60) % 24;
  return `${h % 12 || 12}:${pad2(m % 60)} ${h < 12 ? 'AM' : 'PM'}`;
}
const fmtMins = (mins) => { const h = Math.floor(mins / 60); const m = Math.round(mins % 60); return [h ? `${h} h` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' '); };
const round2 = (n) => Math.round(n * 100) / 100;
// "yyyy-MM-dd HH:mm" (how the webhooks stamp times) as a local Date
const stampDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || '')); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null; };

const mySessions = () => (state.data.sessions || []);
const liveSession = () => mySessions().find((s) => s.status === 'Open' || s.status === 'Paused') || null;
const reviewSessions = () => mySessions().filter((s) => s.status === 'Needs review');
// Log rows that belong to a session: tagged with it, or checked off after it started and not tagged yet
function sessionLog(s) {
  if (!s) return [];
  const since = `${s.date} ${s.start}`;
  return state.data.log.filter((l) => l.session_id === s.session_id
    || (!l.session_id && l.completed_by === state.data.user.name && String(l.completed_at || '') >= since));
}
function sessionMinutes(s) {
  const start = stampDate(`${s.date} ${s.start}`);
  if (!start) return 0;
  const until = s.status === 'Paused' ? (stampDate(s.paused_at) || new Date()) : new Date();
  return Math.max(0, Math.round((until - start) / 60000) - (Number(s.break_minutes) || 0));
}

function renderSessionBar() {
  if (!state.data) return;
  const s = liveSession();
  const review = reviewSessions();
  $('session-btn').hidden = !!s;
  const bar = $('session-bar');
  const parts = [];
  if (s) {
    const paused = s.status === 'Paused';
    const done = sessionLog(s).filter((l) => l.ticket_id).length;
    parts.push(el('div', { class: `session-now${paused ? ' paused' : ''}` },
      el('span', { class: 'session-dot', 'aria-hidden': 'true' }),
      el('span', {}, paused ? `Paused at ${clock(String(s.paused_at).slice(11))}` : `Working since ${clock(s.start)}`),
      el('strong', {}, fmtMins(sessionMinutes(s))),
      done ? el('span', { class: 'session-count' }, `${plural(done, 'task')} checked off`) : null,
      el('span', { class: 'session-actions' },
        paused
          ? el('button', { type: 'button', class: 'top-btn', onclick: () => sessionAction('resume') }, 'Resume')
          : el('button', { type: 'button', class: 'top-btn', onclick: () => openPause() }, 'Pause'),
        el('button', { type: 'button', class: 'top-btn solid', onclick: () => openEndSession(s) }, 'End session'))));
  }
  if (review.length) {
    parts.push(el('div', { class: 'session-review' },
      `${plural(review.length, 'session')} saved for review`,
      el('button', { type: 'button', class: 'link', onclick: () => openEndSession(review[0], true) }, `Review ${shortDate(review[0].date)}`)));
  }
  bar.hidden = !parts.length;
  bar.replaceChildren(el('div', { class: 'session-inner' }, parts));
}

async function sessionAction(action) {
  try {
    status(action === 'start' ? 'Starting session…' : 'Saving…');
    await post('session', { action });
    await load();
    status(action === 'start' ? 'Session started' : action === 'pause' ? 'Session paused' : 'Session resumed');
    setTimeout(() => status(''), 1500);
  } catch (ex) { status(`Could not save: ${ex.message}`); }
}

// Pause now, and optionally get a reminder to come back after 15, 30 or 60 minutes
function openPause() {
  const dlg = $('dialog');
  const pick = (mins) => async () => {
    dlg.close();
    await sessionAction('pause');
    if (mins) {
      clearTimeout(state.pauseTimer);
      state.pauseTimer = setTimeout(() => {
        status('Break is up. Press Resume when you are back.');
        try { if (window.Notification && Notification.permission === 'granted') new Notification('Break is up', { body: 'Resume your session when you are back.' }); } catch (e) { /* no notifications here */ }
      }, mins * 60000);
      try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
  };
  dlg.replaceChildren(el('div', { class: 'form' },
    el('h2', {}, 'Pause session'),
    el('p', { class: 'form-sub' }, 'Paused time comes off the session hours.'),
    el('div', { class: 'pause-picks' },
      [15, 30, 60].map((m) => el('button', { type: 'button', class: 'secondary', onclick: pick(m) }, `${m} min`)),
      el('button', { type: 'button', class: 'secondary', onclick: pick(0) }, 'Until I resume')),
    el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, 'Cancel'))));
  dlg.showModal();
}

const clientCode = (projectId) => (projectOf(projectId) || {}).client || 'WIPP';
const typeOf = (l) => l.time_type || (state.data.tickets.find((t) => t.ticket_id === l.ticket_id) || {}).time_type || (projectOf(l.project) || {}).time_type || 'Billable';

// Recap: one line per project. Timesheet line: one combined line, "CLIENT - item, item" per client, no periods.
function buildRecap(items) {
  const byProject = new Map();
  for (const it of items) {
    if (!it.task) continue;
    const k = it.project || '';
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k).push(it.task + (it.hours ? ` (${fmtMins(it.hours * 60)})` : ''));
  }
  return [...byProject].map(([p, list]) => `${p ? projectName(p) : 'No project'}: ${list.join(', ')}`).join('\n');
}
function buildTimesheet(items) {
  const byClient = new Map();
  for (const it of items) {
    if (!it.task) continue;
    const k = it.project ? clientCode(it.project) : 'WIPP';
    if (!byClient.has(k)) byClient.set(k, []);
    const name = it.task.replace(/[.]+$/, '');
    if (!byClient.get(k).includes(name)) byClient.get(k).push(name);
  }
  return [...byClient].map(([c, list]) => `${c} - ${list.join(', ')}`).join('; ').replace(/\./g, '');
}

function openEndSession(s, isReview = false) {
  const d = state.data;
  const entries = sessionLog(s);
  const tasks = entries.filter((l) => l.source !== 'Extra' && l.source !== 'Calendar');
  const extras = entries.filter((l) => l.source === 'Extra' || l.source === 'Calendar');
  const removed = [];
  const projOpts = [['', 'Choose a project'], ...sortProjects([...d.projects].filter((p) => !CLOSED.includes(p.status))).map((p) => [p.project_id, p.display_name])];
  const typeOpts = [['', 'Project default'], ...TIME_TYPES.map((x) => [x, x])];
  const live = !isReview && (s.status === 'Open' || s.status === 'Paused');
  const pausedExtra = s.status === 'Paused' && stampDate(s.paused_at) ? Math.round((new Date() - stampDate(s.paused_at)) / 60000) : 0;

  const startIn = el('input', { name: 'start', type: 'time', value: s.start || '' });
  const endIn = el('input', { name: 'end', type: 'time', value: live ? nowHM() : (s.end || nowHM()) });
  const brkIn = el('input', { name: 'break_minutes', type: 'number', min: 0, step: 5, value: (Number(s.break_minutes) || 0) + pausedExtra });
  const hoursIn = el('input', { name: 'hours', type: 'number', min: 0, step: 0.05, value: '' });
  let hoursTouched = isReview && s.hours !== '' && s.hours !== undefined;
  if (hoursTouched) hoursIn.value = s.hours;
  const totalLine = el('p', { class: 'field-hint session-total' });

  const taskRows = el('div', { class: 'end-rows' }, tasks.length ? tasks.map((l) => el('div', { class: 'end-row', 'data-log': l.log_id },
    el('div', { class: 'end-row-head' }, el('strong', {}, `${l.ticket_id} ${l.task}`), el('span', {}, projectName(l.project))),
    el('textarea', { 'data-k': 'what_was_done', rows: 2, 'aria-label': `Summary for ${l.ticket_id}` }, l.what_was_done || ''),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Time'), timeStepper(`t_${l.log_id}`, l.actual_hours === '' ? 0 : l.actual_hours)),
      field('Time type', select(`tt_${l.log_id}`, typeOpts, l.time_type || ''))),
  )) : [el('p', { class: 'meter-empty' }, 'No tasks checked off during this session yet.')]);

  const extraRows = el('div', { class: 'end-rows' });
  const addExtra = (x = {}) => {
    const row = el('div', { class: 'end-row extra', 'data-log': x.log_id || '' },
      el('div', { class: 'row' },
        field('What was it', el('input', { 'data-k': 'task', value: x.task || '', placeholder: 'Client call, training video…' })),
        field('Project', select('', projOpts, x.project || 'P-007'))),
      el('div', { class: 'row' },
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Time'), timeStepper(`x_${Math.random().toString(36).slice(2)}`, x.actual_hours === undefined || x.actual_hours === '' ? 0.5 : x.actual_hours)),
        field('Time type', select('', typeOpts, x.time_type || ''))),
      field('Note', el('input', { 'data-k': 'note', value: x.what_was_done || '' })),
      x.source === 'Calendar' ? el('p', { class: 'field-hint' }, 'From your calendar') : null,
      el('button', { type: 'button', class: 'link remove', onclick: () => { if (x.log_id) removed.push(x.log_id); row.remove(); updateTotal(); } }, 'Remove'));
    row.querySelectorAll('select')[0].setAttribute('data-k', 'project');
    row.querySelectorAll('select')[1].setAttribute('data-k', 'time_type');
    row.addEventListener('click', () => setTimeout(updateTotal, 0));
    extraRows.append(row);
  };
  extras.forEach(addExtra);

  const recapBox = el('textarea', { name: 'recap', rows: 3 }, s.recap || '');
  const sheetBox = el('textarea', { name: 'timesheet_line', rows: 2 }, s.timesheet_line || '');

  // Everything in the popup as {task, project, hours}
  const collect = () => {
    const out = [];
    taskRows.querySelectorAll('.end-row').forEach((r) => {
      const l = tasks.find((x) => x.log_id === r.dataset.log);
      out.push({ log_id: l.log_id, task: l.task, project: l.project, kind: 'task',
        what_was_done: r.querySelector('[data-k="what_was_done"]').value,
        hours: Number(r.querySelector(`[name="t_${l.log_id}"]`).value) || 0,
        time_type: r.querySelector(`[name="tt_${l.log_id}"]`).value });
    });
    extraRows.querySelectorAll('.end-row').forEach((r) => {
      out.push({ log_id: r.dataset.log || undefined, kind: 'extra',
        task: r.querySelector('[data-k="task"]').value.trim(),
        project: r.querySelector('[data-k="project"]').value,
        hours: Number(r.querySelector('.stepper input[type="hidden"]').value) || 0,
        time_type: r.querySelector('[data-k="time_type"]').value,
        note: r.querySelector('[data-k="note"]').value.trim() });
    });
    return out;
  };
  const autoHours = () => {
    const a = hmToMin(startIn.value); const b = hmToMin(endIn.value);
    if (a === null || b === null) return '';
    let span = b - a; if (span < 0) span += 1440;
    return round2(Math.max(0, span - (Number(brkIn.value) || 0)) / 60);
  };
  function updateTotal() {
    if (!hoursTouched) hoursIn.value = autoHours();
    const sum = round2(collect().reduce((t, x) => t + x.hours, 0));
    totalLine.textContent = `Tasks and extras add up to ${sum} h. Session is ${hoursIn.value || 0} h.`;
  }
  const rebuild = () => {
    const items = collect();
    recapBox.value = buildRecap(items);
    sheetBox.value = buildTimesheet(items);
  };
  [startIn, endIn, brkIn].forEach((i) => i.addEventListener('input', updateTotal));
  hoursIn.addEventListener('input', () => { hoursTouched = hoursIn.value !== ''; updateTotal(); });
  taskRows.addEventListener('click', () => setTimeout(updateTotal, 0));

  showDialog(isReview ? `Review session ${s.date}` : 'End session', [
    el('div', { class: 'row' },
      field('Date', el('input', { name: 'date', type: 'date', value: s.date || todayIso() })),
      field('Start', startIn), field('End', endIn)),
    el('div', { class: 'row' },
      field('Break minutes', brkIn),
      field('Session hours', hoursIn, 'Fills in from the times. Type to override')),
    totalLine,
    el('h3', { class: 'end-title' }, 'Tasks checked off'),
    taskRows,
    el('div', { class: 'end-title-row' }, el('h3', { class: 'end-title' }, 'Extras'),
      el('button', { type: 'button', class: 'link', onclick: () => { addExtra(); updateTotal(); } }, 'Add an extra')),
    el('p', { class: 'field-hint' }, 'Calls, meetings, videos or anything that was not a task'),
    extraRows,
    el('div', { class: 'end-title-row' }, el('h3', { class: 'end-title' }, 'Recap'),
      el('button', { type: 'button', class: 'link', onclick: rebuild }, 'Rebuild from tasks and extras')),
    field('By project', recapBox),
    field('Timesheet line for Gusto', sheetBox, 'Copied when you save'),
  ], async (v, form, submitter) => {
    const items = collect();
    const review = submitter && submitter.value === 'review';
    await post('session', {
      action: 'end', session_id: s.session_id, date: v.date, start: v.start, end: v.end,
      break_minutes: v.break_minutes, hours: hoursTouched ? v.hours : '',
      tasks: items.filter((x) => x.kind === 'task').map((x) => ({ log_id: x.log_id, actual_hours: x.hours, what_was_done: x.what_was_done, time_type: x.time_type })),
      extras: items.filter((x) => x.kind === 'extra' && x.task).map((x) => ({ log_id: x.log_id, task: x.task, project: x.project, hours: x.hours, time_type: x.time_type, note: x.note })),
      remove_log_ids: removed, recap: v.recap, timesheet_line: v.timesheet_line, review,
    });
    try { await navigator.clipboard.writeText(v.timesheet_line); } catch (e) { /* clipboard blocked */ }
    status(review ? 'Saved for review later' : 'Session saved. Timesheet line copied');
    setTimeout(() => status(''), 2500);
  }, 'Save session', null, [{ label: 'Review later', value: 'review' }]);

  if (!recapBox.value && !sheetBox.value) rebuild();
  updateTotal();
}

// ---------- hours ----------
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseIso = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? new Date(+m[1], m[2] - 1, +m[3]) : null; };
const addDays = (iso, n) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const mondayOf = (iso) => { const d = parseIso(iso); const back = (d.getDay() + 6) % 7; d.setDate(d.getDate() - back); return isoOf(d); };
const shortDate = (iso) => { const d = parseIso(iso); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : iso; };
// completed_at can come back as "2026-11-21 13:05" or "11/21/2026 13:05"
const logDay = (l) => { const v = String(l.completed_at || ''); return toIso(v.slice(0, 10)) || toIso(v.split(' ')[0]) || ''; };

function weekSettings(ws) {
  const row = (state.data.weeks || []).find((w) => String(w.week_start).slice(0, 10) === ws || toIso(String(w.week_start)) === ws);
  const cap = row && row.capacity_hours !== '' ? Number(row.capacity_hours) : 40;
  const frozen = row && row.frozen_hours !== '' ? Number(row.frozen_hours) : (ws < FULL_TIME_START ? DEFAULT_FROZEN : 0);
  return { capacity: cap, frozen, notes: row ? row.notes : '', saved: !!row };
}

function weekData(ws) {
  const we = addDays(ws, 7);
  const me = state.data.user.name;
  const entries = state.data.log.filter((l) => l.completed_by === me && logDay(l) >= ws && logDay(l) < we)
    .map((l) => ({ ...l, _type: typeOf(l), _hours: Number(l.actual_hours) || 0, _day: logDay(l) }));
  const byType = Object.fromEntries(TIME_TYPES.map((t) => [t, 0]));
  for (const e of entries) byType[e._type] = round2((byType[e._type] || 0) + e._hours);
  const total = round2(entries.reduce((t, e) => t + e._hours, 0));
  const sessions = mySessions().filter((s) => s.date >= ws && s.date < we && s.status !== 'Open' && s.status !== 'Paused');
  return { entries, byType, total, sessions };
}

function copyButton(getText, label = 'Copy list') {
  return el('button', { type: 'button', class: 'link', onclick: async () => {
    try { await navigator.clipboard.writeText(getText()); status('Copied'); } catch (e) { status('Copy was blocked by the browser'); }
    setTimeout(() => status(''), 1500);
  } }, label);
}

function renderHours() {
  const view = $('view-hours');
  if (!state.week) state.week = mondayOf(todayIso());
  const ws = state.week;
  const set = weekSettings(ws);
  const available = Math.max(0, set.capacity - set.frozen);
  const w = weekData(ws);
  const left = round2(available - w.total);
  const scale = available / 40;

  // Week bar: logged time by type, then what's left, then frozen hours
  const segs = [...TIME_TYPES.map((t) => [t, w.byType[t]]), ['Left', Math.max(0, left)], ['Frozen', set.frozen]].filter(([, h]) => h > 0);
  const barTotal = Math.max(set.capacity, w.total + set.frozen) || 1;
  const bar = el('div', { class: 'week-bar', role: 'img', 'aria-label': `${w.total} of ${available} hours logged` },
    segs.map(([t, h]) => el('div', { class: 'week-seg', 'data-type': t, style: `flex: ${h} 1 0`, title: `${t}: ${h} h` },
      (h / barTotal) > 0.07 ? el('span', {}, `${round2(h)}`) : null)));

  const framework = FRAMEWORK.map(([label, types, lo, hi, hint]) => {
    const got = round2(types.reduce((t, x) => t + (w.byType[x] || 0), 0));
    const min = round2(lo * scale); const max = round2(hi * scale);
    const note = got < min ? `${round2(min - got)} h under` : got > max ? `${round2(got - max)} h over` : 'In range';
    const top = Math.max(max * 1.25, got, 1);
    return el('div', { class: 'fw-row' },
      el('div', { class: 'fw-head' }, el('strong', {}, label), el('span', {}, `${got} h of ${min} to ${max} h`), el('span', { class: `fw-note${note === 'In range' ? ' ok' : ''}` }, note)),
      el('div', { class: 'fw-track' },
        el('div', { class: 'fw-range', style: `left: ${(min / top) * 100}%; width: ${((max - min) / top) * 100}%` }),
        el('div', { class: 'fw-fill', 'data-type': types[0], style: `width: ${Math.min(100, (got / top) * 100)}%` })),
      el('p', { class: 'field-hint' }, hint));
  });

  // Day by day
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const dayRow = el('div', { class: 'day-row' }, days.map((day) => {
    const h = round2(w.entries.filter((e) => e._day === day).reduce((t, e) => t + e._hours, 0));
    const sh = round2(w.sessions.filter((s) => s.date === day).reduce((t, s) => t + (Number(s.hours) || 0), 0));
    return el('div', { class: `day${day === todayIso() ? ' today' : ''}` },
      el('span', { class: 'day-name' }, parseIso(day).toLocaleDateString('en-US', { weekday: 'short' })),
      el('strong', {}, h ? `${h} h` : '–'),
      sh ? el('span', { class: 'day-sess' }, `session ${sh} h`) : null);
  }));

  // By project
  const projIds = [...new Set(w.entries.map((e) => e.project))];
  const projRows = sortProjects(projIds.map((id) => projectOf(id) || { project_id: id, display_name: id || 'No project', status: '' })).map((p) => {
    const mine = w.entries.filter((e) => e.project === p.project_id);
    const h = round2(mine.reduce((t, e) => t + e._hours, 0));
    const split2 = TIME_TYPES.map((t) => [t, round2(mine.filter((e) => e._type === t).reduce((s, e) => s + e._hours, 0))]).filter(([, x]) => x);
    const weekly = Number(p.weekly_hours) || 0;
    return el('tr', {},
      el('td', {}, p.project_id && projectOf(p.project_id) ? el('a', { class: 'project-link', href: `#project/${encodeURIComponent(p.project_id)}` }, p.display_name) : p.display_name),
      el('td', {}, el('div', { class: 'type-chips' }, split2.map(([t, x]) => el('span', { class: 'type-chip', 'data-type': t }, `${t} ${x}`)))),
      el('td', { class: 'num' }, `${h} h`),
      el('td', { class: 'num' }, weekly ? `${weekly} h` : ''),
      el('td', { class: 'num' }, projectOf(p.project_id) ? hoursText(p) : ''));
  });

  // Client-facing billable lists, plus Internal time on client projects for the boss
  const clientGroups = (type, onlyClients) => {
    const groups = new Map();
    for (const e of w.entries.filter((x) => x._type === type)) {
      const p = projectOf(e.project) || {};
      if (onlyClients && isSecondary(p)) continue;
      const c = p.client || 'WIPP';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(e);
    }
    return [...groups];
  };
  const listText = (c, list, label) => [`Week of ${shortDate(ws)} - ${c} ${label}`,
    ...list.map((e) => `${[e.ticket_id, e.task].filter(Boolean).join(' ')} - ${e._hours} h`),
    `Total ${round2(list.reduce((t, e) => t + e._hours, 0))} h`].join('\n');
  const groupPanel = (title, groups, label, empty) => el('div', { class: 'panel' },
    el('h3', {}, title),
    groups.length ? groups.map(([c, list]) => el('div', { class: 'bill-group' },
      el('div', { class: 'projects-head' },
        el('strong', {}, `${c}: ${round2(list.reduce((t, e) => t + e._hours, 0))} h`),
        copyButton(() => listText(c, list, label))),
      el('ul', { class: 'bill-list' }, list.map((e) => el('li', {},
        el('span', {}, [e.ticket_id, e.task].filter(Boolean).join(' ')),
        el('span', { class: 'num' }, `${e._hours} h`)))))) : el('p', { class: 'meter-empty' }, empty));

  const noTime = w.entries.filter((e) => !e._hours).length;

  view.replaceChildren(
    el('div', { class: 'projects-head' },
      el('h2', { id: 'hours-title' }, 'Hours'),
      el('div', { class: 'week-nav' },
        el('button', { type: 'button', class: 'secondary nav-btn', 'aria-label': 'Previous week', onclick: () => { state.week = addDays(ws, -7); render(); } }, '‹'),
        el('strong', {}, `Week of ${shortDate(ws)} to ${shortDate(addDays(ws, 6))}`),
        el('button', { type: 'button', class: 'secondary nav-btn', 'aria-label': 'Next week', onclick: () => { state.week = addDays(ws, 7); render(); } }, '›'),
        ws !== mondayOf(todayIso()) ? el('button', { type: 'button', class: 'link', onclick: () => { state.week = mondayOf(todayIso()); render(); } }, 'This week') : null)),
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('span', {}, 'Logged'), el('strong', {}, `${w.total} h`), el('span', {}, `of ${available} h available`)),
      el('div', { class: 'tile' }, el('span', {}, left >= 0 ? 'Left' : 'Over'), el('strong', {}, `${Math.abs(left)} h`), el('span', {}, 'this week')),
      el('div', { class: 'tile' }, el('span', {}, 'Frozen'), el('strong', {}, `${set.frozen} h`), el('span', {}, set.frozen ? `of ${set.capacity} h` : 'none this week')),
      el('div', { class: 'tile' }, el('span', {}, 'Sessions'), el('strong', {}, `${round2(w.sessions.reduce((t, s) => t + (Number(s.hours) || 0), 0))} h`), el('span', {}, plural(w.sessions.length, 'session')))),
    el('div', { class: 'panel' },
      el('div', { class: 'projects-head' }, el('h3', {}, 'This week'),
        el('button', { type: 'button', class: 'link', onclick: () => openWeekEdit(ws, set) }, 'Adjust this week')),
      set.notes ? el('p', { class: 'field-hint' }, set.notes) : null,
      bar,
      el('div', { class: 'legend' }, [...TIME_TYPES, 'Left', 'Frozen'].map((t) => el('span', { 'data-type': t }, t))),
      dayRow,
      noTime ? el('p', { class: 'field-hint' }, `${plural(noTime, 'entry')} this week ${noTime === 1 ? 'has' : 'have'} no time. Add it with Edit in the Log.`) : null),
    el('div', { class: 'panel' },
      el('h3', {}, '40-hour framework'),
      el('p', { class: 'field-hint' }, scale === 1 ? 'Targets for a full 40-hour week' : `Targets scaled to your ${available} available hours`),
      framework),
    el('div', { class: 'panel' },
      el('h3', {}, 'By project'),
      projRows.length ? el('div', { class: 'table-wrap flat' }, el('table', { class: 'tasks-table hours-table' },
        el('thead', {}, el('tr', {}, ['Project', 'Time types', 'This week', 'Weekly target', 'Total'].map((h, i) => el('th', { scope: 'col', class: i > 1 ? 'num' : null }, el('span', { class: 'th' }, h))))),
        el('tbody', {}, projRows))) : el('p', { class: 'meter-empty' }, 'Nothing logged this week yet.')),
    el('div', { class: 'page-grid' },
      groupPanel('Billable by client', clientGroups('Billable', false), 'billable', 'No billable time this week yet.'),
      groupPanel('Internal time on client projects', clientGroups('Internal', true), 'internal (not billed)', 'No internal time on client projects this week.')),
    el('div', { class: 'panel' },
      el('h3', {}, 'Sessions'),
      w.sessions.length ? el('ol', { class: 'log-list' }, w.sessions.map((s) => el('li', { class: 'log-item' },
        el('div', { class: 'log-head' },
          el('strong', {}, `${shortDate(s.date)}, ${clock(s.start)} to ${clock(s.end)}`),
          el('span', {}, [`${s.hours} h`, s.status === 'Needs review' ? 'Needs review' : ''].filter(Boolean).join(', '))),
        s.timesheet_line ? el('p', { class: 'sheet-line' }, s.timesheet_line) : null,
        el('div', { class: 'card-actions' },
          s.timesheet_line ? copyButton(() => s.timesheet_line, 'Copy timesheet line') : null,
          el('button', { type: 'button', class: 'link', onclick: () => openEndSession(s, true) }, s.status === 'Needs review' ? 'Review' : 'Edit'))))) : el('p', { class: 'meter-empty' }, 'No finished sessions this week.')),
  );
}

function openWeekEdit(ws, set) {
  showDialog(`Adjust week of ${shortDate(ws)}`, [
    el('div', { class: 'row' },
      field('Capacity hours', el('input', { name: 'capacity_hours', type: 'number', min: 0, step: 0.25, value: set.capacity })),
      field('Frozen hours', el('input', { name: 'frozen_hours', type: 'number', min: 0, step: 0.25, value: set.frozen }), 'Hours held back, like the 15 until Jan 11')),
    field('Notes', el('input', { name: 'notes', value: set.notes || '' })),
  ], async (v) => {
    await post('session', { action: 'week_save', week_start: ws, ...v });
    status('Week saved');
  }, 'Save week');
}

// Next due date for a repeating task, same rule as the webhook (always after today)
function nextDue(t) {
  let d = parseIso(toIso(t.due_date) || todayIso());
  const today = parseIso(todayIso());
  do {
    if (t.repeat === 'Monthly') d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + (t.repeat === 'Every 2 weeks' ? 14 : 7));
  } while (d <= today);
  return isoOf(d);
}

// ---------- events ----------
window.addEventListener('hashchange', () => {
  const v = route().view;
  // A project page opens focused (Up next tucked away); Back to the dashboard returns to the dual layout
  if (v === 'project' && state.lastView !== 'project') state.projLayout = 'projects';
  if (v === 'home' && state.lastView === 'project') state.layout = 'split';
  state.lastView = v;
  render();
  window.scrollTo(0, 0);
});
$('push-left').addEventListener('click', pushLeft);
$('push-right').addEventListener('click', pushRight);
$('strip-left').addEventListener('click', () => setLayout('split'));
$('strip-right').addEventListener('click', () => setLayout('split'));
$('next-fold').addEventListener('click', () => {
  state.nextFolded = !state.nextFolded;
  applyLayout(route().view);
  if (state.nextFolded) {
    const target = route().view === 'project' ? $('view-project') : $('view-home');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
$('session-btn').addEventListener('click', () => sessionAction('start'));
$('refresh').addEventListener('click', () => load());
$('new-task').addEventListener('click', () => state.data && openTask({}));
$('new-project').addEventListener('click', () => state.data && openProject(null));
$('ticketing').addEventListener('change', (e) => { state.ticketing = e.target.checked; render(); });
$('show-closed').addEventListener('change', (e) => { state.showClosed = e.target.checked; render(); });
$('gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveKey($('gate-key').value.trim());
  load();
});

state.lastView = route().view;
load();
// Keep the session timer fresh
setInterval(() => { if (state.data && liveSession()) renderSessionBar(); }, 30000);
