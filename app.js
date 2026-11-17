// Project Dashboard front end. Data comes from the n8n webhooks; the Google Sheet is the database.
const API = 'https://n8n.wippdata.com/webhook/wipp-dashboard';
const CLOSED = ['Done', 'Canceled'];
const KEY_STORE = 'pd_key';

const $ = (id) => document.getElementById(id);
const state = { data: null, client: 'all', showClosed: false };

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

// ---------- small DOM helper ----------
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

function status(msg) {
  $('status-line').textContent = msg || '';
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
}

function projectName(d, id) {
  const p = d.projects.find((x) => x.project_id === id);
  return p ? p.display_name : id;
}

function renderNext(d) {
  const list = $('next-list');
  list.replaceChildren();
  if (!d.my_top5.length) {
    list.append(el('li', { class: 'next-empty' }, 'Nothing is assigned to you right now. New tickets with your name on them show up here.'));
    return;
  }
  for (const t of d.my_top5) {
    list.append(el('li', { class: 'next-item', 'data-priority': t.priority },
      el('span', { class: 'next-task' }, t.task),
      el('span', { class: 'next-meta' },
        el('span', {}, projectName(d, t.project)),
        el('span', {}, `${t.priority || 'Low'} priority`),
        t.due_date ? el('span', {}, `Due ${t.due_date}`) : null,
        t.status !== 'Open' ? el('span', {}, t.status) : null,
      ),
    ));
  }
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
  if (new URLSearchParams(location.search).get('preview') === 'maintenance') wrap.append(maintenancePreview());

  const clients = state.client === 'all' ? d.clients : d.clients.filter((c) => c.client === state.client);
  let shown = 0;
  for (const c of clients) {
    const projects = d.projects.filter((p) => p.client === c.client && (state.showClosed || !CLOSED.includes(p.status)));
    if (!projects.length) continue;
    shown += projects.length;
    wrap.append(el('div', { class: 'client-group' },
      el('h3', { class: 'client-name' }, el('strong', {}, c.client), c.company_name || ''),
      projects.map((p) => projectCard(d, p)),
    ));
  }
  if (!shown) wrap.append(el('p', { class: 'meter-empty' }, 'No open projects for this client. Tick "Show done and canceled" to see the rest.'));
}

function projectCard(d, p) {
  const facts = [];
  if (p.open_tickets) facts.push(`${p.open_tickets} open ticket${p.open_tickets === 1 ? '' : 's'}`);
  if (p.done_tickets) facts.push(`${p.done_tickets} done`);
  if (p.members) facts.push(`Team: ${p.members}`);

  return el('article', { class: `project${CLOSED.includes(p.status) ? ' closed' : ''}` },
    el('h3', {}, p.display_name),
    el('span', { class: 'project-status', 'data-status': p.status }, p.status),
    el('div', { class: 'project-body' },
      p.notes ? el('p', { class: 'project-note' }, p.notes) : null,
      p.status === 'Maintenance' ? gauge(maintenanceLoad(p), true) : meter(p),
      facts.length ? el('div', { class: 'project-facts' }, facts.map((f) => el('span', {}, f))) : null,
      split(p.tools).length ? el('div', { class: 'tags', 'aria-label': 'Tools' }, split(p.tools).map((t) => el('span', { class: 'tag' }, t))) : null,
    ),
  );
}

// One block per milestone; each block fills by its own tickets and locks full when the milestone is Done.
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

// Maintenance load: weekly hours out of a 40-hour week when set, otherwise open tickets.
function maintenanceLoad(p) {
  const hrs = Number(p.weekly_hours);
  if (hrs > 0) return Math.min(1, hrs / 40);
  return Math.min(1, (p.open_tickets || 0) / 10);
}
function gaugeStage(load) {
  if (load >= 0.5) return ['heavy', 'Big features plus upkeep'];
  if (load >= 0.25) return ['steady', 'Steady upkeep'];
  if (load >= 0.1) return ['light', 'Light upkeep'];
  return ['cruise', 'Cruising, check in now and then'];
}
function gauge(load, withText) {
  const [stage, label] = gaugeStage(load);
  return el('div', { class: 'gauge-row' },
    el('div', { class: 'gauge', 'data-stage': stage, role: 'img', 'aria-label': `Maintenance load ${Math.round(load * 100)}%, ${label}` },
      el('span', {}, `${Math.round(load * 100)}%`)),
    withText ? el('div', { class: 'gauge-text' }, el('strong', {}, 'Maintenance'), label) : null,
  );
}
function maintenancePreview() {
  return el('div', { class: 'preview' },
    el('h3', {}, 'Maintenance gauge preview'),
    el('div', { class: 'preview-row' }, [0.6, 0.35, 0.15, 0.05].map((l) => gauge(l, true))),
  );
}

// ---------- events ----------
$('refresh').addEventListener('click', load);
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
