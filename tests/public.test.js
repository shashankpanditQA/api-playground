'use strict';
process.env.PROGRESS_FILE = 'off';
process.env.PUBLIC_MODE = 'true';
process.env.PUBLIC_RATE_LIMIT = '200';
process.env.PUBLIC_MAX_RECORDS = '20';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('mocks cannot act as web pages on the public domain', async () => {
  await post('/api/mocks', { method: 'GET', path: '/page', response: { status: 200, headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': 'default-src *' }, body: '<script>alert(1)</script>' } });
  const res = await fetch(`${base}/mock/page`);
  assert.equal(res.headers.get('content-security-policy'), 'sandbox');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('the number of mocks is capped', async () => {
  await fetch(`${base}/api/mocks`, { method: 'DELETE' });
  for (let i = 0; i < 50; i += 1) assert.equal((await post('/api/mocks', { method: 'GET', path: `/m${i}`, response: { status: 200 } })).status, 201);
  const over = await post('/api/mocks', { method: 'GET', path: '/over', response: { status: 200 } });
  assert.equal(over.status, 409);
  assert.equal((await over.json()).error.code, 'TOO_MANY_MOCKS');
  await post('/api/admin/reset', {});
});

test('bodies over the public limit are rejected', async () => {
  const res = await post('/api/headers/echo', { a: 'x'.repeat(60000) });
  assert.equal(res.status, 413);
});

test('stored data clears itself at the record cap', async () => {
  for (let i = 0; i < 25; i += 1) await fetch(`${base}/api/simulate/flaky/n${i}?failTimes=0`);
  const res = await fetch(`${base}/api/simulate/flaky/n0?failTimes=0`);
  assert.ok(Number(res.headers.get('x-attempt')) < 3);
});

test('each client is rate limited, and health stays open', async () => {
  let last;
  for (let i = 0; i < 205; i += 1) last = await fetch(`${base}/api/complex/company`);
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error.code, 'PLATFORM_RATE_LIMITED');
  assert.ok(last.headers.get('retry-after'));
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
