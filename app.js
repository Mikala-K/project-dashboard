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
const KEY_STORE = 'pd_key';

const $ = (id) => document.getElementById(id);
const state = {
  data: null, client: 'all', showClosed: false, ticketing: false,
  openCards: new Set(), openTasks: new Set(),
  sort: { key: 'priority', dir: 1 }, filter: { project: '', assignee: '', category: '' }, logProject: '',
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
    body.log = body.log || [];
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

// ---------- routing ----------
function route() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('project/')) return { view: 'project', id: decodeURIComponent(h.slice(8)) };
  if (h === 'tasks' || h === 'log') return { view: h };
  return { view: 'home' };
}
function render() {
  if (!state.data) return;
  const r = route();
  $('hello').textContent = `Hi ${state.data.user.name}`;
  for (const v of ['home', 'tasks', 'log', 'project']) $(`view-${v}`).hidden = v !== r.view;
  const wide = r.view === 'tasks' || r.view === 'log';
  $('next-section').hidden = wide;
  $('app').classList.toggle('full', wide);
  document.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === r.view ? 'page' : 'false'));
  renderNext();
  if (r.view === 'home') { renderChips(); renderProjects(); }
  if (r.view === 'tasks') renderTasks();
  if (r.view === 'log') renderLog();
  if (r.view === 'project') renderProjectPage(r.id);
}

// ---------- task rows (Up next, cards, project page) ----------
const byStatusThenId = (a, b) => (a.status === 'Backlog') - (b.status === 'Backlog') || idNum(a.ticket_id) - idNum(b.ticket_id);

function taskRow(t, opts = {}) {
  const kids = opts.withSubtasks ? subtasksOf(t) : [];
  const expanded = opts.expandAll || state.openTasks.has(t.ticket_id);
  const meta = [
    opts.showProject ? projectName(t.project) : null,
    `${t._priority || t.priority || 'Low'} priority${t._from ? `, from ${t._from}` : ''}`,
    t.due_date ? `Due ${t.due_date}` : null,
    t.status !== 'Open' ? t.status : null,
    t.category || null,
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
function showDialog(title, formKids, onSave, saveLabel, after) {
  const dlg = $('dialog');
  const err = el('p', { class: 'form-error', role: 'alert' });
  const form = el('form', { method: 'dialog', class: 'form' },
    el('h2', {}, title), ...formKids, err,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, saveLabel)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.primary');
    btn.disabled = true; err.textContent = '';
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      await onSave(values, form);
      dlg.close();
      await load();
      if (after) after();
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
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
    field('Notes', el('textarea', { name: 'notes', rows: 2 }, t.notes || '')),
    cats,
  ], async (v) => {
    if (task) await post('ticket/update', { ticket_id: t.ticket_id, ...v });
    else await post('ticket', v);
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
  showDialog('Check off task', [
    el('p', { class: 'form-sub' }, `${t.ticket_id} ${t.task}`),
    kids.length ? el('p', { class: 'form-warn' }, `This also checks off its ${plural(kids.length, 'open subtask')} (${kids.map((k) => k.ticket_id).join(', ')}) with the note "Done with ${t.ticket_id}" and 0 min.`) : null,
    field('Summary or findings', doneBox(), 'Leave it as "done" or click in to write your own'),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Estimated time spent on task'), timeStepper('actual_hours', t.actual_hours)),
  ], async (v) => {
    for (const k of kids) await post('ticket/update', { ticket_id: k.ticket_id, complete: { what_was_done: `Done with ${t.ticket_id}`, actual_hours: 0 } });
    await post('ticket/update', { ticket_id: t.ticket_id, complete: v });
    status('Checked off and saved to the log');
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
  showDialog('Edit log entry', [
    el('p', { class: 'form-sub' }, [l.ticket_id, l.task].filter(Boolean).join(' ')),
    field('Summary or findings', el('textarea', { name: 'what_was_done', rows: 4 }, l.what_was_done || '')),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Time spent'), timeStepper('actual_hours', l.actual_hours === '' ? 0 : l.actual_hours)),
    field('Time type', select('time_type', [['', `Project default (${p.time_type || 'Billable'})`], ...TIME_TYPES.map((x) => [x, x])], l.time_type || '')),
  ], async (v) => {
    await post('session', { action: 'log_edit', log_id: l.log_id, ...v });
    if (l.ticket_id) await post('ticket/update', { ticket_id: l.ticket_id, actual_hours: v.actual_hours }).catch(() => {});
    status('Log entry saved');
  }, 'Save entry');
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

// ---------- events ----------
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
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

load();
