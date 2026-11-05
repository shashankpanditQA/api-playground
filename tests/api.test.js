'use strict';
process.env.PROGRESS_FILE = 'off';
process.env.PAYMENT_SLOW_MS = '500';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const challenges = require('../src/challenges');
const { progress, clearProgress } = require('../src/store');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(async () => {
  await fetch(`${base}/api/admin/reset`, { method: 'POST' });
});

const API_KEY = { 'X-API-Key': 'pk_test_playground', 'Content-Type': 'application/json' };

async function call(method, path, { headers = {}, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const payment = (token = 'tok_success', value = 10000) => ({
  amount: { value, currency: 'INR' },
  source: { accountId: 'ACC-1001', token },
  destination: { accountId: 'ACC-9001' },
});
const pay = (key, body = payment()) => call('POST', '/api/payments', { headers: { ...API_KEY, 'Idempotency-Key': key }, body });
const balance = async (id) => (await call('GET', `/api/accounts/${id}`, { headers: API_KEY })).json.balance;
const debits = async (id = 'ACC-1001') =>
  (await call('GET', `/api/accounts/${id}/ledger`, { headers: API_KEY })).json.entries.filter((e) => e.type === 'DEBIT').length;

// Every challenge's documented steps must really work and really earn the tick.
function fill(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (match, name) => {
      if (name === 'uuid') return crypto.randomUUID();
      if (name === 'now') return String(Math.floor(Date.now() / 1000));
      return name in vars ? vars[name] : match;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

for (const challenge of challenges) {
  test(`challenge: ${challenge.title}`, async () => {
    clearProgress();
    const vars = { apiKey: 'pk_test_playground', idemKey: `run-${crypto.randomUUID()}` };
    for (const step of challenge.steps) {
      if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
      const headers = fill(step.headers || {}, vars);
      const hasBody = step.body !== undefined || step.bodyRaw !== undefined;
      if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      const send = () => call(step.method, fill(step.path, vars), { headers, body: step.bodyRaw ?? fill(step.body, vars) });

      let results;
      if (step.parallel) results = await Promise.all(Array.from({ length: step.parallel }, send));
      else {
        results = [];
        for (let i = 0; i < (step.repeat || 1); i += 1) results.push(await send());
      }

      if (step.parallel) {
        assert.deepEqual(results.map((r) => r.status).sort(), step.expect, step.name);
      } else {
        const last = results[results.length - 1];
        assert.equal(last.status, step.expect, `${step.name}: ${last.text}`);
        for (const [h, v] of Object.entries(step.expectHeaders || {})) assert.equal(last.headers.get(h), v, `${step.name}: header ${h}`);
        for (const [name, field] of Object.entries(step.capture || {})) vars[name] = last.json[field];
        for (const [name, h] of Object.entries(step.captureHeaders || {})) vars[name] = last.headers.get(h);
      }
    }
    assert.ok(progress[challenge.id], `${challenge.id} was not ticked after its steps ran`);
  });
}

test('challenge ids are unique', () => {
  assert.equal(new Set(challenges.map((c) => c.id)).size, challenges.length);
});

test('replay returns the identical payment and moves money once', async () => {
  const start = await balance('ACC-1001');
  const first = await pay('replay-key-0001');
  const second = await pay('replay-key-0001');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.json, first.json);
  assert.equal(first.headers.get('idempotent-replayed'), 'false');
  assert.equal(second.headers.get('idempotent-replayed'), 'true');
  assert.equal(await balance('ACC-1001'), start - 10000);
  assert.equal(await balance('ACC-9001'), 10000);
  assert.equal(await debits(), 1);
});

test('20 identical concurrent requests charge exactly once', async () => {
  const start = await balance('ACC-1001');
  const results = await Promise.all(Array.from({ length: 20 }, () => pay('storm-key-0001')));
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  assert.deepEqual(counts, { 201: 1, 409: 19 });
  for (const r of results.filter((x) => x.status === 409)) assert.equal(r.headers.get('retry-after'), '1');
  assert.equal(await balance('ACC-1001'), start - 10000);
  assert.equal(await debits(), 1);
  const retry = await pay('storm-key-0001');
  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
});

test('key order does not change the fingerprint', async () => {
  await pay('order-key-0001');
  const { amount, source, destination } = payment();
  const reordered = await pay('order-key-0001', { destination, source, amount: { currency: amount.currency, value: amount.value } });
  assert.equal(reordered.status, 201);
  assert.equal(reordered.headers.get('idempotent-replayed'), 'true');
});

test('a changed body with the same key is rejected and not charged', async () => {
  await pay('reuse-key-0001');
  const reuse = await pay('reuse-key-0001', payment('tok_success', 20000));
  assert.equal(reuse.status, 422);
  assert.equal(reuse.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await debits(), 1);
});

test('timeout after charge: the 504 moved money, the retry does not move it again', async () => {
  const start = await balance('ACC-1001');
  const body = payment('tok_timeout_after_charge');
  assert.equal((await pay('timeout-key-01', body)).status, 504);
  assert.equal(await balance('ACC-1001'), start - 10000);
  const retry = await pay('timeout-key-01', body);
  assert.equal(retry.status, 201);
  assert.equal(await balance('ACC-1001'), start - 10000);
  assert.equal(await debits(), 1);
});

test('failure before charge: no money on the 500, one charge on the retry', async () => {
  const start = await balance('ACC-1001');
  const body = payment('tok_server_error_once');
  assert.equal((await pay('error-key-0001', body)).status, 500);
  assert.equal(await balance('ACC-1001'), start);
  const retry = await pay('error-key-0001', body);
  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get('idempotent-replayed'), 'false');
  assert.equal(await balance('ACC-1001'), start - 10000);
});

test('declines and low balance are 402, stored and replayed, with no money moved', async () => {
  const start = await balance('ACC-1001');
  const declined = await pay('decline-key-01', payment('tok_declined'));
  assert.equal(declined.status, 402);
  assert.equal(declined.json.failure.code, 'CARD_DECLINED');
  const replay = await pay('decline-key-01', payment('tok_declined'));
  assert.equal(replay.status, 402);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  const poor = await pay('poor-key-00001', payment('tok_success', start + 1));
  assert.equal(poor.status, 402);
  assert.equal(poor.json.failure.code, 'INSUFFICIENT_FUNDS');
  assert.equal(await balance('ACC-1001'), start);
});

test('keys are scoped per user', async () => {
  await pay('shared-key-0001');
  const login = await call('POST', '/api/auth/login', { headers: API_KEY, body: { username: 'admin', password: 'admin123' } });
  const other = await call('POST', '/api/payments', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.json.accessToken}`, 'Idempotency-Key': 'shared-key-0001' },
    body: payment(),
  });
  assert.equal(other.status, 201);
  assert.equal(other.headers.get('idempotent-replayed'), 'false');
  assert.equal(await debits(), 2);
});

test('invalid requests do not burn the key', async () => {
  const bad = await pay('burn-key-00001', { amount: { value: -1, currency: 'USD' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.error.details.some((d) => d.path === 'amount.value'));
  assert.equal((await pay('burn-key-00001')).status, 201);
});

test('partial refunds add up, cannot exceed the payment, and replay safely', async () => {
  const paid = await pay('refund-pay-001');
  const refund = (key, value) =>
    call('POST', `/api/payments/${paid.json.id}/refunds`, { headers: { ...API_KEY, 'Idempotency-Key': key }, body: { amount: { value, currency: 'INR' } } });
  assert.equal((await refund('refund-key-001', 6000)).status, 201);
  assert.equal((await refund('refund-key-001', 6000)).headers.get('idempotent-replayed'), 'true');
  assert.equal((await refund('refund-key-002', 6000)).status, 422);
  assert.equal((await refund('refund-key-003', 4000)).status, 201);
  assert.equal(await balance('ACC-9001'), 0);
  assert.equal(await balance('ACC-1001'), 5000000);
});

test('money is conserved across a busy mix of operations', async () => {
  const total = async () => {
    const { json } = await call('GET', '/api/accounts', { headers: API_KEY });
    return json.data.reduce((sum, a) => sum + a.balance, 0);
  };
  const start = await total();
  await Promise.all([
    pay('mix-key-000001'),
    pay('mix-key-000001'),
    pay('mix-key-000002', payment('tok_declined')),
    pay('mix-key-000003', payment('tok_timeout_after_charge')),
    pay('mix-key-000004', payment('tok_server_error_once')),
    call('POST', '/api/payments/unsafe', { headers: API_KEY, body: payment() }),
  ]);
  assert.equal(await total(), start);
});

test('login rejects wrong passwords and prototype-key usernames', async () => {
  for (const username of ['tester', '__proto__', 'constructor']) {
    const res = await call('POST', '/api/auth/login', { headers: API_KEY, body: { username, password: 'nope' } });
    assert.equal(res.status, 401, username);
  }
});

test('a tampered JWT is rejected', async () => {
  const { json } = await call('POST', '/api/auth/login', { headers: API_KEY, body: { username: 'viewer', password: 'viewer123' } });
  const [head, , sig] = json.accessToken.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', role: 'admin', exp: 9999999999 })).toString('base64url');
  const res = await call('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${head}.${forged}.${sig}` } });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'TOKEN_INVALID');
});

test('merge patch keeps siblings, removes on null, recalculates, and blocks read-only fields', async () => {
  const patch = (body) => call('PATCH', '/api/orders/ORD-1001', { headers: { ...API_KEY, 'Content-Type': 'application/merge-patch+json' }, body });
  const res = await patch({ customer: { address: { city: 'Mysuru', geo: null } } });
  assert.equal(res.status, 200);
  assert.equal(res.json.customer.address.city, 'Mysuru');
  assert.equal(res.json.customer.address.pincode, '560001');
  assert.equal('geo' in res.json.customer.address, false);
  assert.equal(res.json.version, 2);
  assert.equal(res.headers.get('etag'), '"v2"');
  assert.equal((await patch({ totals: { grandTotal: 1 } })).status, 422);
  assert.equal((await patch({ status: 'DELIVERED' })).status, 409);
  const repriced = await patch({ items: [{ sku: 'X', quantity: 1, unitPrice: { value: 100, currency: 'INR' } }] });
  assert.equal(repriced.json.totals.grandTotal, 118);
});

test('merge patch ignores __proto__', async () => {
  const res = await call('PATCH', '/api/orders/ORD-1001', {
    headers: API_KEY,
    body: '{"__proto__":{"polluted":true},"customer":{"name":"Safe"}}',
  });
  assert.equal(res.status, 200);
  assert.equal({}.polluted, undefined);
});

test('stale If-Match leaves the order unchanged, and PUT without it gets 428', async () => {
  const order = (await call('GET', '/api/orders/ORD-1001', { headers: API_KEY })).json;
  const body = { customer: order.customer, items: order.items };
  const noHeader = await call('PUT', '/api/orders/ORD-1001', { headers: API_KEY, body });
  assert.equal(noHeader.status, 428);
  const stale = await call('PUT', '/api/orders/ORD-1001', { headers: { ...API_KEY, 'If-Match': '"v9"' }, body });
  assert.equal(stale.status, 412);
  assert.equal((await call('GET', '/api/orders/ORD-1001', { headers: API_KEY })).json.version, 1);
  const good = await call('PUT', '/api/orders/ORD-1001', { headers: { ...API_KEY, 'If-Match': '"v1"' }, body });
  assert.equal(good.status, 200);
  assert.equal(good.json.version, 2);
});

test('validation reports exact nested paths', async () => {
  const res = await call('POST', '/api/orders', { headers: API_KEY, body: challenges.find((c) => c.id === 'nested-field-error').steps[0].body });
  const paths = res.json.error.details.map((d) => d.path);
  for (const expected of ['customer.contact.email', 'customer.contact.phones[0].number', 'customer.address.pincode', 'customer.address.geo.lat', 'items[0].quantity', 'items[0].unitPrice.value', 'items[0].unitPrice.currency', 'items[0].discounts[0].percent', 'items[1].sku']) {
    assert.ok(paths.includes(expected), `missing ${expected}`);
  }
});

test('documented total for the sample order is right', async () => {
  const res = await call('POST', '/api/orders', { headers: API_KEY, body: challenges.find((c) => c.id === 'nested-create').steps[0].body });
  assert.equal(res.json.totals.grandTotal, 1805199);
});

test('filter, sort, pagination and sparse fields', async () => {
  const list = await call('GET', '/api/orders?customer.address.city=Bengaluru&sort=-totals.grandTotal&limit=1', { headers: API_KEY });
  assert.equal(list.headers.get('x-total-count'), '2');
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].id, 'ORD-1001');
  assert.match(list.headers.get('link'), /rel="next"/);
  const sparse = await call('GET', '/api/orders/ORD-1001?fields=customer.name,totals.grandTotal', { headers: API_KEY });
  assert.deepEqual(Object.keys(sparse.json).sort(), ['customer', 'totals']);
  assert.deepEqual(Object.keys(sparse.json.customer), ['name']);
});

test('mock template keeps types and fills strings', async () => {
  await call('POST', '/api/mocks', {
    headers: API_KEY,
    body: { method: 'POST', path: '/t/:id', response: { status: 200, headers: { 'X-Echo': '{{params.id}}' }, body: { whole: '{{body.nested}}', text: 'id={{params.id}}', missing: '{{query.none}}', uuid: '{{uuid}}' } } },
  });
  const res = await call('POST', '/mock/t/9', { headers: API_KEY, body: { nested: { n: 1 } } });
  assert.deepEqual(res.json.whole, { n: 1 });
  assert.equal(res.json.text, 'id=9');
  assert.equal(res.json.missing, null);
  assert.match(res.json.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers.get('x-echo'), '9');
});

test('mock priority, delay, loop, near misses and invalid definitions', async () => {
  const create = (body) => call('POST', '/api/mocks', { headers: API_KEY, body });
  await create({ method: 'GET', path: '/p', priority: 5, response: { status: 200, body: { from: 'high' } } });
  await create({ method: 'GET', path: '/p', priority: 1, response: { status: 200, body: { from: 'low' } } });
  assert.equal((await call('GET', '/mock/p')).json.from, 'high');

  await create({ method: 'GET', path: '/slow', response: { status: 200, body: {}, delayMs: 300 } });
  const started = Date.now();
  await call('GET', '/mock/slow');
  assert.ok(Date.now() - started >= 290);

  await create({ method: 'GET', path: '/loop', afterLast: 'loop', responses: [{ status: 200, body: {} }, { status: 500, body: {} }] });
  const seen = [];
  for (let i = 0; i < 3; i += 1) seen.push((await call('GET', '/mock/loop')).status);
  assert.deepEqual(seen, [200, 500, 200]);

  const near = await call('POST', '/mock/p');
  assert.equal(near.status, 404);
  assert.equal(near.json.error.details.nearMisses.length, 2);

  assert.equal((await create({ method: 'FETCH', path: 'no-slash', response: { status: 99 } })).status, 422);
  assert.equal((await create({ method: 'GET', path: '/x', response: { status: 200 }, responses: [{ status: 200 }] })).status, 422);
});

test('negative paths and framework-level errors use the same error shape', async () => {
  const bad = await call('POST', '/api/orders', { headers: API_KEY, body: '{"broken": ' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_JSON');
  const unknown = await call('GET', '/api/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'ROUTE_NOT_FOUND');
  assert.ok(unknown.json.error.requestId);
  const big = await call('POST', '/api/headers/echo', { headers: API_KEY, body: JSON.stringify({ a: 'x'.repeat(1100000) }) });
  assert.equal(big.status, 413);
});

test('request id is echoed; negotiation, drift, and the generator behave', async () => {
  assert.equal((await call('GET', '/health', { headers: { 'X-Request-Id': 'abc' } })).headers.get('x-request-id'), 'abc');
  assert.match((await call('GET', '/api/headers/negotiate', { headers: { Accept: 'text/csv' } })).text, /^id,name,city/);
  assert.equal((await call('GET', '/api/headers/negotiate', { headers: { Accept: 'image/png' } })).status, 406);
  const a = await call('GET', '/api/complex/generate?depth=3&breadth=2&seed=7');
  const b = await call('GET', '/api/complex/generate?depth=3&breadth=2&seed=7');
  const c = await call('GET', '/api/complex/generate?depth=3&breadth=2&seed=8');
  assert.equal(a.text, b.text);
  assert.notEqual(a.text, c.text);
  assert.equal(a.json.nodeCount, 15);
  assert.equal((await call('GET', '/api/complex/generate?depth=12&breadth=10')).status, 400);
});

test('reset restores data and keeps progress unless asked', async () => {
  await pay('reset-key-00001');
  clearProgress();
  await call('POST', '/api/auth/login', { headers: API_KEY, body: { username: 'tester', password: 'tester123' } });
  await call('POST', '/api/admin/reset');
  assert.equal(await balance('ACC-1001'), 5000000);
  assert.ok(progress['auth-login']);
  await call('POST', '/api/admin/reset?progress=true');
  assert.equal(progress['auth-login'], undefined);
});

test('docs and spec are served, and every path in the spec is reachable', async () => {
  assert.equal((await call('GET', '/docs/')).status, 200);
  const { json } = await call('GET', '/openapi.json');
  assert.equal(json.openapi, '3.0.3');
  for (const path of Object.keys(json.paths)) {
    const url = path.replace('{code}', '200').replace('{ms}', '0').replace(/\{[^}]+\}/g, 'x');
    const op = Object.keys(json.paths[path])[0];
    const res = await call(op.toUpperCase(), url, { headers: API_KEY, body: ['post', 'put', 'patch'].includes(op) ? {} : undefined });
    assert.notEqual(res.json?.error?.code, 'ROUTE_NOT_FOUND', path);
  }
});
