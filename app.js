// Project Dashboard front end. Data comes from the n8n webhooks; the Google Sheet is the database.
const API = 'https://n8n.wippdata.com/webhook/wipp-dashboard';
const CLOSED = ['Done', 'Canceled'];
const STATUS_ORDER = ['Active', 'Maintenance', 'Ramping up', 'On hold', 'Prospect', 'Done', 'Canceled'];
const PROJECT_STATUSES = ['Prospect', 'Ramping up', 'Active', 'On hold', 'Maintenance', 'Done', 'Canceled'];
const TICKET_STATUSES = ['Open', 'In progress', 'Blocked', 'Backlog'];
const KEY_STORE = 'pd_key';

const $ = (id) => document.getElementById(id);
const state = { data: null, client: 'all', showClosed: false, openProjects: new Set(), view: 'projects',
  sort: { key: 'ticket_id', dir: 1 }, filter: { project: '', assignee: '', category: '' }, expanded: new Set() };

// ---------- key handling ----------
function storedKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
}
function saveKey(k) {
  try { localStorage.setItem(KEY_STORE, k); } catch (e) { /* private mode: key lives in the URL only */ }
}
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
const toIso = (v) => {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};
const rank = (s) => { const i = STATUS_ORDER.indexOf(s); return i < 0 ? 99 : i; };

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

// ---------- load ----------
async function load() {
  const key = currentKey();
  if (!key) { showGate(); return; }
  status('Loading…');
  try {
    const res = await fetch(`${API}?key=${encodeURIComponent(key)}`);
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { showGate('That key did not work. Check your dashboard link.'); status(''); return; }
    if (!res.ok || !body.ok) throw new Error(body.error || `Server answered ${res.status}`);
    state.data = body;
    $('gate').hidden = true;
    render();
    status('');
  } catch (err) {
    status('Could not load the dashboard. Check your connection and press Refresh.');
    console.error(err);
  }
}
function showGate(msg) {
  $('gate').hidden = false;
  $('gate-error').textContent = msg || '';
  $('gate-key').focus();
}

// ---------- render ----------
function render() {
  const d = state.data;
  $('hello').textContent = `Hi ${d.user.name}`;
  renderNext(d);
  renderChips(d);
  renderProjects(d);
  renderAllTickets(d);
  showView();
}
function showView() {
  const tickets = state.view === 'tickets';
  $('projects').hidden = tickets;
  $('all-tickets').hidden = !tickets;
  $('view-all').textContent = tickets ? 'Back to projects' : 'View all tickets';
}
const projectOf = (d, id) => d.projects.find((x) => x.project_id === id);
const projectName = (d, id) => (projectOf(d, id) || {}).display_name || id;

function ticketRow(d, t, showProject) {
  const blocked = t.status === 'Blocked' || t.blocked_by;
  return el('li', { class: 'ticket', 'data-priority': t.priority },
    el('input', { type: 'checkbox', class: 'tick', 'aria-label': `Check off ${t.task}`, onchange: (e) => { e.target.checked = false; openComplete(t); } }),
    el('button', { type: 'button', class: 'ticket-open', onclick: () => openTicket({ ticket: t }) },
      el('span', { class: 'ticket-task' }, t.task),
      el('span', { class: 'ticket-meta' },
        showProject ? el('span', {}, projectName(d, t.project)) : null,
        el('span', {}, `${t.priority || 'Low'} priority`),
        t.due_date ? el('span', {}, `Due ${t.due_date}`) : null,
        t.status !== 'Open' ? el('span', {}, t.status) : null,
        t.category ? el('span', {}, t.category) : null,
        t.assignee && !showProject ? el('span', {}, t.assignee) : (!t.assignee ? el('span', {}, 'Unassigned') : null),
        blocked && t.blocked_by ? el('span', {}, `Waiting on ${t.blocked_by}`) : null,
      ),
    ),
  );
}

function renderNext(d) {
  const list = $('next-list');
  list.replaceChildren();
  if (!d.my_top5.length) {
    list.append(el('li', { class: 'next-empty' }, 'Nothing is assigned to you right now. Use New ticket to add one.'));
    return;
  }
  for (const t of d.my_top5) list.append(ticketRow(d, t, true));
}

function renderChips(d) {
  const box = $('client-chips');
  box.replaceChildren();
  const make = (value, label) => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(state.client === value),
    onclick: () => { state.client = value; renderChips(d); renderProjects(d); },
  }, label);
  box.append(make('all', 'All clients'));
  for (const c of d.clients) box.append(make(c.client, c.client));
}

function renderProjects(d) {
  const wrap = $('project-groups');
  wrap.replaceChildren();
  if (new URLSearchParams(location.search).get('preview') === 'maintenance') wrap.append(...maintenancePreview(d));

  const projects = d.projects
    .filter((p) => state.client === 'all' || p.client === state.client)
    .filter((p) => state.showClosed || !CLOSED.includes(p.status))
    .sort((a, b) => rank(a.status) - rank(b.status) || a.display_name.localeCompare(b.display_name));

  if (state.client !== 'all') {
    const c = d.clients.find((x) => x.client === state.client);
    if (c) wrap.append(el('p', { class: 'client-line' }, el('strong', {}, c.company_name || c.client), c.primary_contacts ? `Contacts: ${c.primary_contacts}` : null));
  }
  if (!projects.length) wrap.append(el('p', { class: 'meter-empty' }, 'No open projects here. Tick "Show done and canceled" to see the rest.'));
  for (const p of projects) wrap.append(projectCard(d, p));
}

function projectCard(d, p) {
  const tickets = d.tickets.filter((t) => t.project === p.project_id);
  const isOpen = state.openProjects.has(p.project_id);
  const facts = [];
  if (p.open_tickets) facts.push(`${p.open_tickets} open ticket${p.open_tickets === 1 ? '' : 's'}`);
  if (p.members) facts.push(`Team: ${p.members}`);

  const toggle = () => {
    if (isOpen) state.openProjects.delete(p.project_id); else state.openProjects.add(p.project_id);
    renderProjects(d);
  };

  return el('article', { class: `project${CLOSED.includes(p.status) ? ' closed' : ''}` },
    el('h3', {}, p.display_name),
    el('span', { class: 'project-status', 'data-status': p.status }, p.status),
    el('div', { class: 'project-body' },
      p.notes ? el('p', { class: 'project-note' }, p.notes) : null,
      p.status === 'Maintenance' ? maintenanceRow(p) : meter(p),
      facts.length ? el('div', { class: 'project-facts' }, facts.map((f) => el('span', {}, f))) : null,
      split(p.tools).length ? el('div', { class: 'tags', 'aria-label': 'Tools' }, split(p.tools).map((t) => el('span', { class: 'tag' }, t))) : null,
      el('div', { class: 'card-actions' },
        el('button', { type: 'button', class: 'link', 'aria-expanded': String(isOpen), onclick: toggle }, isOpen ? 'Hide tickets' : `Show tickets (${tickets.length})`),
        el('button', { type: 'button', class: 'link', onclick: () => openTicket({ project: p.project_id }) }, 'Add ticket'),
        el('button', { type: 'button', class: 'link', onclick: () => openProject(p) }, 'Edit project'),
      ),
      isOpen ? ticketTree(d, tickets) : null,
    ),
  );
}

// Parent tickets with their subtasks tucked underneath
function ticketTree(d, tickets) {
  if (!tickets.length) return el('p', { class: 'meter-empty' }, 'No open tickets on this project.');
  const ids = new Set(tickets.map((t) => t.ticket_id));
  const tops = tickets.filter((t) => !t.parent_ticket || !ids.has(t.parent_ticket));
  const order = (a, b) => (a.status === 'Backlog') - (b.status === 'Backlog');
  return el('ul', { class: 'ticket-list' }, tops.sort(order).map((t) => {
    const kids = tickets.filter((k) => k.parent_ticket === t.ticket_id);
    const row = ticketRow(d, t, false);
    if (kids.length) row.append(el('ul', { class: 'ticket-list sub' }, kids.sort(order).map((k) => ticketRow(d, k, false))));
    return row;
  }));
}

// One block per milestone; each block fills by its own tickets and locks full when the milestone is Done.
function meter(p, compact) {
  if (p.segments && p.segments.length) {
    const current = p.segments.find((s) => s.status !== 'Done');
    return el('div', { class: 'meter-wrap' },
      el('div', { class: 'meter', role: 'img', 'aria-label': `${p.progress}% complete across ${p.segments.length} milestones` },
        p.segments.map((s) => el('div', {
          class: `seg${s.status === 'Done' ? ' done' : ''}`,
          style: `flex: ${s.share} 1 0`, title: `${s.milestone}: ${Math.round(s.fill * 100)}%`,
        }, el('div', { class: 'seg-fill', style: `width: ${Math.round(s.fill * 100)}%` }))),
      ),
      compact ? null : el('div', { class: 'meter-labels' },
        el('span', {}, current ? `Now: ${current.milestone}` : 'All milestones done'),
        el('span', { class: 'meter-pct' }, `${p.progress}%`),
      ),
    );
  }
  if (p.progress !== null && p.progress !== undefined) {
    return el('div', { class: 'meter-wrap' },
      el('div', { class: 'meter', role: 'img', 'aria-label': `${p.progress}% complete` },
        el('div', { class: 'seg', style: 'flex: 1 1 0' }, el('div', { class: 'seg-fill', style: `width: ${p.progress}%` }))),
      compact ? null : el('div', { class: 'meter-labels' }, el('span', {}, 'Set by hand'), el('span', { class: 'meter-pct' }, `${p.progress}%`)),
    );
  }
  return compact ? null : el('p', { class: 'meter-empty' }, 'No milestones yet');
}

// ---------- maintenance ----------
function maintenanceLoad(p) {
  const hrs = Number(p.weekly_hours);
  if (hrs > 0) return Math.min(1, hrs / 40);
  return Math.min(1, (p.open_tickets || 0) / 10);
}
const STAGES = [
  [0.5, 'heavy', 'Big features plus upkeep', 'New features are still being built while one-off fixes come in.'],
  [0.25, 'steady', 'Steady upkeep', 'The big pieces are done. Regular fixes and tweaks each week.'],
  [0.1, 'light', 'Light upkeep', 'A few small changes. Quick check-ins keep it healthy.'],
  [0, 'cruise', 'Cruising', 'Check in weekly to monthly. Earning with very little upkeep.'],
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
  const phase = last ? last.split(' - ')[0] : 'Build';
  return el('div', { class: 'maint' },
    el('div', { class: 'maint-done' },
      el('div', { class: 'maint-arrow' }, el('span', {}, 'Complete')),
      el('p', { class: 'maint-caption' }, `${phase} complete, in maintenance mode`),
    ),
    el('div', { class: 'maint-gauge' },
      gauge(load),
      el('div', { class: 'gauge-text' }, el('strong', {}, label), detail),
    ),
  );
}
function maintenancePreview(d) {
  const base = projectOf(d, 'P-001') || { segments: [] };
  return [0.6, 0.35, 0.15, 0.05].map((load) => projectCard(d, {
    ...base, project_id: `preview-${load}`, display_name: `Preview - ${stageFor(load)[2]}`,
    status: 'Maintenance', notes: 'Sample card, only shown with the preview link', weekly_hours: load * 40,
    open_tickets: 0, tools: '', members: '',
  }));
}


// ---------- all tickets ----------
const idNum = (id) => Number(String(id || '').replace(/\D/g, '')) || 0;
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const TICKET_STATUS_RANK = { 'In progress': 0, Open: 1, Blocked: 2, Backlog: 3 };
const COLUMNS = [
  ['ticket_id', 'ID', (t) => idNum(t.ticket_id)],
  ['task', 'Task', (t) => t.task.toLowerCase()],
  ['project', 'Project', (t) => projectName(state.data, t.project)],
  ['category', 'Category', (t) => (t.category || '~').toLowerCase()],
  ['assignee', 'Assignee', (t) => t.assignee || '~'],
  ['priority', 'Priority', (t) => PRIORITY_RANK[t.priority] ?? 3],
  ['status', 'Status', (t) => TICKET_STATUS_RANK[t.status] ?? 9],
  ['due_date', 'Due', (t) => toIso(t.due_date) || '9999'],
];

function renderAllTickets(d) {
  const f = state.filter;
  const filters = $('ticket-filters');
  const sel = (key, label, options) => field(label, el('select', {
    onchange: (e) => { f[key] = e.target.value; renderAllTickets(d); },
  }, options.map(([v, l]) => el('option', { value: v, selected: f[key] === v }, l))));
  const cats = [...new Set(d.tickets.map((t) => t.category).filter(Boolean))].sort();
  filters.replaceChildren(
    sel('project', 'Project', [['', 'All projects'], ...d.projects.filter((p) => d.tickets.some((t) => t.project === p.project_id)).map((p) => [p.project_id, p.display_name])]),
    sel('assignee', 'Assignee', [['', 'Everyone'], ['-', 'Unassigned'], ...d.people.map((n) => [n, n])]),
    sel('category', 'Category', [['', 'All categories'], ...cats.map((c) => [c, c])]),
  );

  const ids = new Set(d.tickets.map((t) => t.ticket_id));
  const match = (t) => (!f.project || t.project === f.project)
    && (!f.assignee || (f.assignee === '-' ? !t.assignee : split(t.assignee).includes(f.assignee)))
    && (!f.category || t.category === f.category);
  const kidsOf = (t) => d.tickets.filter((k) => k.parent_ticket === t.ticket_id);
  // A parent stays visible when any of its subtasks match the filters
  const tops = d.tickets.filter((t) => !t.parent_ticket || !ids.has(t.parent_ticket))
    .filter((t) => match(t) || kidsOf(t).some(match));
  const [, , keyFn] = COLUMNS.find(([k]) => k === state.sort.key);
  const cmp = (a, b) => {
    const x = keyFn(a); const y = keyFn(b);
    return (x < y ? -1 : x > y ? 1 : 0) * state.sort.dir || idNum(a.ticket_id) - idNum(b.ticket_id);
  };

  const head = el('tr', {}, COLUMNS.map(([k, label]) => {
    const active = state.sort.key === k;
    return el('th', { scope: 'col', 'aria-sort': active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none' },
      el('button', { type: 'button', class: 'sort', onclick: () => {
        state.sort = { key: k, dir: active ? -state.sort.dir : 1 };
        renderAllTickets(d);
      } }, label, active ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : ''));
  }), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Check off')));

  const row = (t, isSub) => {
    const kids = isSub ? [] : kidsOf(t);
    const open = state.expanded.has(t.ticket_id);
    const assign = el('select', { class: 'inline-select', 'aria-label': `Assignee for ${t.ticket_id}`, onchange: async (e) => {
      try { status('Saving…'); await post('ticket/update', { ticket_id: t.ticket_id, assignee: e.target.value }); await load(); status('Assignee saved'); }
      catch (ex) { status(`Could not save: ${ex.message}`); }
    } }, [['', 'Unassigned'], ...d.people.map((n) => [n, n])].map(([v, l]) => el('option', { value: v, selected: (t.assignee || '') === v }, l)));
    return el('tr', { class: isSub ? 'sub-row' : '', 'data-priority': t.priority },
      el('td', { class: 'id-cell' }, t.ticket_id),
      el('td', { class: 'task-cell' },
        el('button', { type: 'button', class: 'ticket-open', onclick: () => openTicket({ ticket: t }) }, el('span', { class: 'ticket-task' }, t.task)),
        kids.length ? el('button', { type: 'button', class: 'link sub-toggle', 'aria-expanded': String(open), onclick: () => {
          if (open) state.expanded.delete(t.ticket_id); else state.expanded.add(t.ticket_id);
          renderAllTickets(d);
        } }, `${open ? 'Hide' : 'Show'} ${kids.length} subtask${kids.length === 1 ? '' : 's'}`) : null),
      el('td', {}, projectName(d, t.project)),
      el('td', {}, t.category || ''),
      el('td', {}, assign),
      el('td', {}, el('span', { class: 'pill', 'data-priority': t.priority }, t.priority || 'Low')),
      el('td', {}, t.status),
      el('td', { class: 'nowrap' }, t.due_date || ''),
      el('td', {}, el('input', { type: 'checkbox', class: 'tick', 'aria-label': `Check off ${t.task}`, onchange: (e) => { e.target.checked = false; openComplete(t); } })),
    );
  };

  const rows = [];
  for (const t of tops.sort(cmp)) {
    rows.push(row(t, false));
    if (state.expanded.has(t.ticket_id)) for (const k of kidsOf(t).sort(cmp)) rows.push(row(k, true));
  }
  $('ticket-table').replaceChildren(rows.length
    ? el('table', { class: 'tickets-table' }, el('thead', {}, head), el('tbody', {}, rows))
    : el('p', { class: 'meter-empty' }, 'No open tickets match these filters.'));
}

// ---------- dialogs ----------
function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('span', { class: 'field-hint' }, hint) : null);
}
function select(name, options, value) {
  return el('select', { name }, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value ?? '') }, l)));
}
function showDialog(title, formKids, onSave, saveLabel) {
  const dlg = $('dialog');
  const err = el('p', { class: 'form-error', role: 'alert' });
  const form = el('form', { method: 'dialog', class: 'form' },
    el('h2', {}, title), ...formKids, err,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: () => dlg.close() }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, saveLabel)),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.primary');
    btn.disabled = true; err.textContent = '';
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      await onSave(values, form);
      dlg.close();
      await load();
    } catch (ex) {
      err.textContent = ex.message;
    } finally { btn.disabled = false; }
  });
  dlg.replaceChildren(form);
  dlg.showModal();
  const first = form.querySelector('input, textarea, select');
  if (first) first.focus();
}

function openTicket({ ticket, project }) {
  const d = state.data;
  const t = ticket || {};
  const projId = t.project || project || '';
  const p = projectOf(d, projId) || {};
  const people = [['', 'Unassigned'], ...d.people.map((n) => [n, n])];
  const projects = [['', 'Choose a project'], ...[...d.projects].sort((a, b) => rank(a.status) - rank(b.status)).map((x) => [x.project_id, x.display_name])];
  const milestones = [['', 'None'], ...d.milestones.filter((m) => m.project_id === projId).map((m) => [m.milestone_id, m.milestone])];
  const parents = [['', 'None (top-level ticket)'], ...d.tickets.filter((x) => x.project === projId && x.ticket_id !== t.ticket_id).map((x) => [x.ticket_id, `${x.ticket_id} ${x.task}`])];
  const cats = el('datalist', { id: 'cat-list' }, split(p.categories).map((c) => el('option', { value: c })));

  const kids = [
    field('Task', el('input', { name: 'task', required: true, value: t.task || '' })),
    field('Description', el('textarea', { name: 'description', rows: 2 }, t.description || '')),
    el('div', { class: 'row' },
      field('Project', select('project', projects, projId)),
      field('Category', el('input', { name: 'category', list: 'cat-list', value: t.category || '' }), 'Like Xano, Softr, G Sheets')),
    el('div', { class: 'row' },
      field('Assignee', select('assignee', people, t.assignee ?? (ticket ? '' : d.user.name))),
      field('Priority', select('priority', [['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']], t.priority || 'Low')),
      field('Status', select('status', TICKET_STATUSES.map((s) => [s, s]), t.status || 'Open'))),
    el('div', { class: 'row' },
      field('Due date', el('input', { name: 'due_date', type: 'date', value: toIso(t.due_date) })),
      field('Estimated hours', el('input', { name: 'est_hours', type: 'number', min: 0, step: 0.25, value: t.est_hours || '' }))),
    el('div', { class: 'row' },
      field('Milestone', select('milestone_id', milestones, t.milestone_id)),
      field('Subtask of', select('parent_ticket', parents, t.parent_ticket))),
    field('Blocked by', el('input', { name: 'blocked_by', value: t.blocked_by || '' }), 'Ticket IDs, like T-004'),
    field('Notes', el('textarea', { name: 'notes', rows: 2 }, t.notes || '')),
    cats,
  ];
  showDialog(ticket ? `Edit ${t.ticket_id}` : 'New ticket', kids, async (v) => {
    if (ticket) await post('ticket/update', { ticket_id: t.ticket_id, ...v });
    else await post('ticket', v);
    status(ticket ? 'Ticket saved' : 'Ticket added');
  }, ticket ? 'Save ticket' : 'Add ticket');

  // Picking a different project refreshes its milestones, possible parent tickets and categories
  const form = $('dialog').querySelector('form');
  form.elements.project.addEventListener('change', (e) => {
    const id = e.target.value;
    const fill = (sel, opts) => sel.replaceChildren(...opts.map(([v, l]) => el('option', { value: v }, l)));
    fill(form.elements.milestone_id, [['', 'None'], ...d.milestones.filter((m) => m.project_id === id).map((m) => [m.milestone_id, m.milestone])]);
    fill(form.elements.parent_ticket, [['', 'None (top-level ticket)'], ...d.tickets.filter((x) => x.project === id && x.ticket_id !== t.ticket_id).map((x) => [x.ticket_id, `${x.ticket_id} ${x.task}`])]);
    $('cat-list').replaceChildren(...split((projectOf(d, id) || {}).categories).map((c) => el('option', { value: c })));
  });
}

function openComplete(t) {
  const kids = [
    el('p', { class: 'form-sub' }, t.task),
    field('What was done', el('textarea', { name: 'what_was_done', rows: 3, required: true })),
    field('What changed or was found', el('textarea', { name: 'what_changed', rows: 2 })),
    field('What to add next', el('textarea', { name: 'next_steps', rows: 2 })),
    field('Hours spent', el('input', { name: 'actual_hours', type: 'number', min: 0, step: 0.25, value: t.actual_hours || '' })),
  ];
  showDialog('Check off ticket', kids, async (v) => {
    await post('ticket/update', { ticket_id: t.ticket_id, complete: v });
    status('Checked off and saved to the log');
  }, 'Check off');
}

function openProject(p) {
  const d = state.data;
  const x = p || {};
  const memberSet = new Set(split(x.members));
  const kids = [
    el('div', { class: 'row' },
      field('Client', select('client', d.clients.map((c) => [c.client, c.client]), x.client || '')),
      field('Project name', el('input', { name: 'project', required: true, value: x.project || '' }))),
    el('div', { class: 'row' },
      field('Status', select('status', PROJECT_STATUSES.map((s) => [s, s]), x.status || 'Active')),
      field('Owner', select('owner', d.people.map((n) => [n, n]), x.owner || d.user.name))),
    el('fieldset', { class: 'field members' }, el('legend', { class: 'field-label' }, 'Members'),
      d.people.map((n) => el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'm', value: n, checked: p ? memberSet.has(n) : n === d.user.name }), n))),
    field('Tools', el('input', { name: 'tools', value: x.tools || '' }), 'Comma separated, like n8n, G Sheets, Claude TBD'),
    field('Categories', el('input', { name: 'categories', value: x.categories || '' }), 'Parts tickets get sorted into, like Softr front end, Xano back end'),
    el('div', { class: 'row' },
      field('Allocated hours', el('input', { name: 'allocated_hours', type: 'number', min: 0, step: 0.5, value: x.allocated_hours || '' })),
      field('Weekly hours', el('input', { name: 'weekly_hours', type: 'number', min: 0, step: 0.5, value: x.weekly_hours || '' }))),
    field('Notes', el('textarea', { name: 'notes', rows: 2 }, x.notes || '')),
  ];
  showDialog(p ? `Edit ${x.display_name}` : 'New project', kids, async (v, form) => {
    const members = [...form.querySelectorAll('input[name="m"]:checked')].map((i) => i.value).join(', ');
    delete v.m;
    await post('project', { ...(p ? { project_id: x.project_id } : {}), ...v, members });
    status(p ? 'Project saved' : 'Project added');
  }, p ? 'Save project' : 'Add project');
}

// ---------- events ----------
$('refresh').addEventListener('click', load);
$('view-all').addEventListener('click', () => { state.view = state.view === 'tickets' ? 'projects' : 'tickets'; showView(); });
$('back-projects').addEventListener('click', () => { state.view = 'projects'; showView(); });
$('new-ticket').addEventListener('click', () => state.data && openTicket({}));
$('new-project').addEventListener('click', () => state.data && openProject(null));
$('show-closed').addEventListener('change', (e) => {
  state.showClosed = e.target.checked;
  if (state.data) renderProjects(state.data);
});
$('gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveKey($('gate-key').value.trim());
  load();
});

load();
