'use strict';
const $ = (id) => document.getElementById(id);
const REASONS = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 207: 'Multi-Status', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 406: 'Not Acceptable', 409: 'Conflict', 412: 'Precondition Failed', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 428: 'Precondition Required', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

// crypto.randomUUID only exists on localhost or HTTPS, so fall back for other addresses.
const uuid = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const newKey = () => `practice-${uuid()}`;
const vars = { apiKey: 'pk_test_playground', idemKey: newKey() };

let challenges = [];
let current = null;
let stepIndex = 0;
let results = [];
let shown = 0;
let tab = 'body';
const completed = new Set();

/* Variables */
function fill(text) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (name === 'uuid') return uuid();
    if (name === 'now') return String(Math.floor(Date.now() / 1000));
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match;
  });
}

function renderVars() {
  const rows = { ...vars, uuid: 'a new UUID on every send', now: 'current Unix time in seconds' };
  $('vars').replaceChildren(...Object.entries(rows).flatMap(([name, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = `{{${name}}}`;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }));
}

/* Rail */
function renderRail() {
  const tracks = new Map();
  for (const c of challenges) {
    if (!tracks.has(c.track)) tracks.set(c.track, []);
    tracks.get(c.track).push(c);
  }
  $('tracks').replaceChildren(...[...tracks].map(([name, list]) => {
    const section = document.createElement('section');
    section.className = 'track';
    const h = document.createElement('h3');
    const count = document.createElement('span');
    count.textContent = `${list.filter((c) => completed.has(c.id)).length} of ${list.length}`;
    h.append(name, count);
    const ul = document.createElement('ul');
    for (const c of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `item${completed.has(c.id) ? ' done' : ''}`;
      if (current?.id === c.id) b.setAttribute('aria-current', 'true');
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = c.title;
      b.append(tick, label);
      b.setAttribute('aria-label', `${c.title}, ${c.level}${completed.has(c.id) ? ', done' : ''}`);
      b.addEventListener('click', () => openChallenge(c));
      li.append(b);
      ul.append(li);
    }
    section.append(h, ul);
    return section;
  }));
  $('free-request').setAttribute('aria-current', String(current === null));
  const total = challenges.length;
  $('progress-text').textContent = `${completed.size} of ${total} challenges passed`;
  $('bar-fill').style.width = total ? `${(completed.size / total) * 100}%` : '0';
}

async function refreshProgress({ announce = true } = {}) {
  const res = await fetch('/api/challenges', { cache: 'no-store' });
  const { data } = await res.json();
  challenges = data;
  const earned = [];
  completed.clear();
  const before = refreshProgress.seen;
  for (const c of data) {
    if (!c.completedAt) continue;
    completed.add(c.id);
    if (before && !before.has(c.id)) earned.push(c);
  }
  refreshProgress.seen = new Set(completed);
  if (announce && earned.length) toast(`Passed: ${earned.map((c) => c.title).join(', ')}`);
  renderRail();
  renderBriefState();
}

/* Brief */
function renderBriefState() {
  const state = $('brief-state');
  if (!current) {
    state.hidden = true;
    return;
  }
  const done = completed.has(current.id);
  state.hidden = false;
  state.className = `state${done ? ' done' : ''}`;
  state.textContent = done ? `Passed, ${current.level.toLowerCase()}` : current.level;
}

function openChallenge(challenge) {
  current = challenge;
  vars.idemKey = newKey();
  renderVars();
  $('brief-title').textContent = challenge.title;
  $('brief-task').textContent = challenge.task;
  $('brief-hint').textContent = challenge.hint;
  $('brief-hint-wrap').hidden = false;
  $('brief-hint-wrap').open = false;
  $('steps-row').hidden = false;
  $('steps').replaceChildren(...challenge.steps.map((step, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = step.repeat ? `${step.name} (${step.repeat} times)` : step.name;
    b.addEventListener('click', () => loadStep(i));
    li.append(b);
    return li;
  }));
  loadStep(0);
  clearResponse();
  renderRail();
  renderBriefState();
}

function openFree() {
  current = null;
  $('brief-title').textContent = 'Write your own request';
  $('brief-task').textContent = 'Call anything on this server. The Swagger docs list every endpoint.';
  $('brief-hint-wrap').hidden = true;
  $('steps-row').hidden = true;
  $('method').value = 'GET';
  $('url').value = '/api/orders/ORD-1002';
  $('headers').value = 'X-API-Key: {{apiKey}}';
  $('body').value = '';
  clearResponse();
  renderRail();
  renderBriefState();
}

function stepHeaders(step) {
  const headers = { ...(step.headers || {}) };
  const hasBody = step.body !== undefined || step.bodyRaw !== undefined;
  if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function stepBody(step) {
  if (step.bodyRaw !== undefined) return step.bodyRaw;
  return step.body === undefined ? '' : JSON.stringify(step.body, null, 2);
}

function loadStep(index) {
  stepIndex = index;
  const step = current.steps[index];
  $('method').value = step.method;
  $('url').value = step.path;
  $('headers').value = Object.entries(stepHeaders(step)).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('body').value = stepBody(step);
  [...$('steps').querySelectorAll('button')].forEach((b, i) => b.setAttribute('aria-current', String(i === index)));
}

/* Sending */
function buildRequest() {
  const headers = {};
  const problems = [];
  for (const line of $('headers').value.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon < 1) {
      problems.push(line.trim());
      continue;
    }
    headers[line.slice(0, colon).trim()] = fill(line.slice(colon + 1).trim());
  }
  if (problems.length) throw new Error(`Each header needs "Name: value". Fix this line: ${problems[0]}`);
  const method = $('method').value;
  const body = ['GET', 'HEAD'].includes(method) || !$('body').value ? undefined : fill($('body').value);
  return { method, url: fill($('url').value.trim()), headers, body };
}

async function perform({ method, url, headers, body }) {
  const started = performance.now();
  try {
    const res = await fetch(url, { method, headers, body, cache: 'no-store', redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, type: res.type, headers: [...res.headers.entries()], text, ms: Math.round(performance.now() - started), url };
  } catch (err) {
    return { error: `${err.message}. Check the path and header values, and that the server is running.`, ms: Math.round(performance.now() - started), url };
  }
}

function setBusy(busy) {
  for (const id of ['send', 'send-twice', 'run-all']) $(id).disabled = busy;
}

function expected() {
  return current ? current.steps[stepIndex].expect : undefined;
}

function applyCaptures(step, result) {
  if (!step || !result.status) return;
  let json;
  try {
    json = JSON.parse(result.text);
  } catch {
    json = undefined;
  }
  for (const [name, field] of Object.entries(step.capture || {})) {
    if (json && json[field] !== undefined) vars[name] = String(json[field]);
  }
  const map = new Map(result.headers);
  for (const [name, header] of Object.entries(step.captureHeaders || {})) {
    if (map.has(header)) vars[name] = map.get(header);
  }
  renderVars();
}

async function send(times) {
  setBusy(true);
  try {
    const request = buildRequest();
    const out = await Promise.all(Array.from({ length: times }, () => perform({ ...request, headers: { ...request.headers } })));
    results = out;
    shown = 0;
    if (current) applyCaptures(current.steps[stepIndex], out[0]);
    renderResponse();
    await refreshProgress();
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(false);
  }
}

async function runAll() {
  setBusy(true);
  try {
    vars.idemKey = newKey();
    for (let i = 0; i < current.steps.length; i += 1) {
      const step = current.steps[i];
      loadStep(i);
      if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
      const request = buildRequest();
      if (step.parallel) {
        results = await Promise.all(Array.from({ length: step.parallel }, () => perform({ ...request, headers: { ...request.headers } })));
      } else {
        for (let n = 0; n < (step.repeat || 1); n += 1) results = [await perform(buildRequest())];
      }
      shown = 0;
      applyCaptures(step, results[0]);
      renderResponse();
    }
    await refreshProgress();
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(false);
  }
}

/* Response */
function clearResponse() {
  results = [];
  const readout = $('readout');
  readout.className = 'readout';
  const p = document.createElement('p');
  p.className = 'waiting';
  p.textContent = 'Send a request to see the response.';
  readout.replaceChildren(p);
  $('tabs').hidden = true;
  $('output').hidden = true;
}

function renderResponse() {
  const r = results[shown];
  const readout = $('readout');
  $('tabs').hidden = false;
  $('output').hidden = false;
  if (r.error) {
    readout.className = 'readout neterr';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const strong = document.createElement('strong');
    strong.textContent = 'No response';
    meta.append(strong, r.error);
    readout.replaceChildren(meta);
    $('output').textContent = '';
    return;
  }
  const status = r.status;
  readout.className = `readout s${String(status)[0] || 3}`;

  const codes = document.createElement('div');
  codes.className = `codes${results.length > 1 ? ' pair' : ''}`;
  results.forEach((res, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'code';
    b.textContent = res.status || 'Err';
    if (results.length > 1) {
      b.setAttribute('aria-pressed', String(i === shown));
      b.setAttribute('aria-label', `Show response ${i + 1}, status ${res.status}`);
      b.addEventListener('click', () => { shown = i; renderResponse(); });
    } else {
      b.disabled = true;
      b.style.cursor = 'default';
      b.style.opacity = 1;
    }
    codes.append(b);
  });

  const meta = document.createElement('div');
  meta.className = 'meta';
  const reason = document.createElement('strong');
  reason.textContent = REASONS[status] || '';
  meta.append(reason, `${r.ms} ms, ${new Blob([r.text]).size} bytes`);
  const want = expected();
  if (want !== undefined) {
    const list = [].concat(want);
    const verdict = document.createElement('span');
    verdict.className = 'verdict';
    verdict.textContent = results.length > 1
      ? `Expected ${list.join(' and ')}`
      : list.includes(status) ? `Matches the expected ${status}` : `This step expects ${list.join(' or ')}`;
    meta.append(verdict);
  }
  readout.replaceChildren(codes, meta);
  renderTab();
}

function highlightJson(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return esc(text).replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (m, str, colon, lit) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (lit) return `<span class="j-lit">${lit}</span>`;
    return `<span class="j-num">${m}</span>`;
  });
}

function renderTab() {
  const r = results[shown];
  if (!r || r.error) return;
  $('tab-body').setAttribute('aria-selected', String(tab === 'body'));
  $('tab-headers').setAttribute('aria-selected', String(tab === 'headers'));
  const out = $('output');
  if (tab === 'headers') {
    out.replaceChildren(...r.headers.flatMap(([k, v]) => {
      const name = document.createElement('span');
      name.className = 'h-name';
      name.textContent = k;
      return [name, document.createTextNode(`: ${v}\n`)];
    }));
    return;
  }
  if (!r.text) {
    out.textContent = 'The response has no body.';
    return;
  }
  try {
    out.innerHTML = highlightJson(JSON.stringify(JSON.parse(r.text), null, 2));
  } catch {
    out.textContent = r.text;
  }
}

/* Extras */
let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 4000);
}

function curl() {
  const { method, url, headers, body } = buildRequest();
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -i -X ${method} ${q(location.origin + url)}`];
  for (const [k, v] of Object.entries(headers)) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (body) parts.push(`--data-raw ${q(body)}`);
  return parts.join(' \\\n  ');
}

$('request-form').addEventListener('submit', (e) => { e.preventDefault(); send(1); });
$('send-twice').addEventListener('click', () => send(2));
$('run-all').addEventListener('click', runAll);
$('free-request').addEventListener('click', openFree);
$('tab-body').addEventListener('click', () => { tab = 'body'; renderTab(); });
$('tab-headers').addEventListener('click', () => { tab = 'headers'; renderTab(); });
$('new-key').addEventListener('click', () => { vars.idemKey = newKey(); renderVars(); toast('Created a new idempotency key'); });
$('copy-curl').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(curl());
    toast('Copied as cURL');
  } catch (err) {
    toast(`Could not copy: ${err.message}`, true);
  }
});
$('reset-data').addEventListener('click', async () => {
  await fetch('/api/admin/reset', { method: 'POST' });
  toast('Data reset. Your progress is kept.');
});
$('reset-all').addEventListener('click', async () => {
  if (!window.confirm('Clear all challenge progress and reset the data?')) return;
  await fetch('/api/admin/reset?progress=true', { method: 'POST' });
  refreshProgress.seen = new Set();
  await refreshProgress({ announce: false });
  toast('Progress cleared and data reset');
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send(1);
});

(async function start() {
  renderVars();
  try {
    await refreshProgress({ announce: false });
    const next = challenges.find((c) => !completed.has(c.id)) || challenges[0];
    openChallenge(next);
  } catch (err) {
    toast(`Could not load challenges: ${err.message}`, true);
  }
})();
