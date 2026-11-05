'use strict';
process.env.PROGRESS_FILE = 'off';
process.env.BANK_KYC_MS = '30';
process.env.BANK_SETTLE_MS = '60';
process.env.BANK_PROCESSING_MS = '40';
process.env.BANK_LOCK_SECONDS = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => `test-${crypto.randomUUID()}`;

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/bank${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
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

const profile = (email, extra = {}) => ({
  fullName: 'Test Person', email, phone: '+919800000001', password: 'Practice123', dateOfBirth: '1990-01-01',
  address: { line1: '1 Lane', city: 'Pune', state: 'MH', pincode: '411001' }, ...extra,
});

async function signIn(email, password = 'Practice123') {
  const login = await api('POST', '/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  const verify = await api('POST', '/auth/otp/verify', { body: { mfaToken: login.json.mfaToken, otp: login.json.devOtp } });
  assert.equal(verify.status, 200);
  return verify.json;
}

async function customer({ verified = true } = {}) {
  const email = `${crypto.randomUUID()}@example.test`;
  assert.equal((await api('POST', '/auth/register', { body: profile(email) })).status, 201);
  const tokens = await signIn(email);
  const token = tokens.accessToken;
  if (verified) {
    assert.equal((await api('POST', '/kyc', { token, body: { documents: [{ type: 'PAN', number: 'ABCDE1234F' }] } })).status, 202);
    await wait(50);
  }
  return { email, token, tokens };
}

const open = async (c) => (await api('POST', '/accounts', { token: c.token, body: { type: 'SAVINGS' } })).json;
const deposit = (c, a, value) => api('POST', `/accounts/${a.id}/deposits`, { token: c.token, body: { amount: { value, currency: 'INR' } }, headers: { 'Idempotency-Key': key() } });
const balance = async (c, a) => (await api('GET', `/accounts/${a.id}/balance`, { token: c.token })).json.available;
async function beneficiary(c, accountNumber, ifsc = 'PLAY0000001', activate = true) {
  const b = await api('POST', '/beneficiaries', { token: c.token, body: { name: 'Friend', accountNumber, ifsc } });
  assert.equal(b.status, 201, b.text);
  if (activate) assert.equal((await api('POST', `/beneficiaries/${b.json.id}/activate`, { token: c.token, body: { otp: b.json.devOtp } })).status, 200);
  return b.json;
}
const send = (c, a, b, value, mode = 'IMPS', k = key()) => api('POST', '/transfers', { token: c.token, headers: { 'Idempotency-Key': k }, body: { fromAccountId: a.id, beneficiaryId: b.id, amount: { value, currency: 'INR' }, mode } });

test('registration validates nested fields, adulthood and duplicates, and never returns the password', async () => {
  const bad = await api('POST', '/auth/register', { body: { fullName: 'X', email: 'nope', phone: '1', password: 'short', dateOfBirth: '2020-01-01', address: { city: '', pincode: '12' } } });
  assert.equal(bad.status, 422);
  const paths = bad.json.error.details.map((d) => d.path);
  for (const p of ['fullName', 'email', 'phone', 'password', 'dateOfBirth', 'address.line1', 'address.city', 'address.state', 'address.pincode']) assert.ok(paths.includes(p), p);
  const email = `Mixed-${crypto.randomUUID()}@Example.test`;
  const ok = await api('POST', '/auth/register', { body: profile(email) });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.kycStatus, 'NOT_SUBMITTED');
  assert.doesNotMatch(ok.text, /Practice123|secret|hash|salt/);
  assert.equal((await api('POST', '/auth/register', { body: profile(email.toLowerCase()) })).status, 409);
  const parallel = `${crypto.randomUUID()}@example.test`;
  const both = await Promise.all([1, 2].map(() => api('POST', '/auth/register', { body: profile(parallel) })));
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
});

test('login does not reveal who is registered; wrong codes run out; lockout clears', async () => {
  const c = await customer({ verified: false });
  const wrong = await api('POST', '/auth/login', { body: { email: c.email, password: 'WrongPass1' } });
  const unknown = await api('POST', '/auth/login', { body: { email: 'nobody@example.test', password: 'WrongPass1' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.json.error.message, unknown.json.error.message);

  const login = await api('POST', '/auth/login', { body: { email: c.email, password: 'Practice123' } });
  const badCode = login.json.devOtp === '000000' ? '000001' : '000000';
  const attempt = () => api('POST', '/auth/otp/verify', { body: { mfaToken: login.json.mfaToken, otp: badCode } });
  assert.equal((await attempt()).json.error.details.attemptsLeft, 2);
  assert.equal((await attempt()).json.error.details.attemptsLeft, 1);
  assert.equal((await attempt()).json.error.details.attemptsLeft, 0);
  const after3 = await api('POST', '/auth/otp/verify', { body: { mfaToken: login.json.mfaToken, otp: login.json.devOtp } });
  assert.equal(after3.json.error.code, 'MFA_TOKEN_INVALID');

  for (let i = 0; i < 4; i += 1) assert.equal((await api('POST', '/auth/login', { body: { email: c.email, password: 'WrongPass1' } })).status, 401);
  const locked = await api('POST', '/auth/login', { body: { email: c.email, password: 'WrongPass1' } });
  assert.equal(locked.status, 423);
  assert.ok(locked.headers.get('retry-after'));
  assert.equal((await api('POST', '/auth/login', { body: { email: c.email, password: 'Practice123' } })).status, 423);
  await wait(1100);
  assert.equal((await api('POST', '/auth/login', { body: { email: c.email, password: 'Practice123' } })).status, 200);
});

test('refresh rotates, reuse ends the sign-in, logout ends the sign-in, and other tokens are refused', async () => {
  const c = await customer({ verified: false });
  const first = await api('POST', '/auth/refresh', { body: { refreshToken: c.tokens.refreshToken } });
  assert.equal(first.status, 200);
  assert.equal((await api('GET', '/me', { token: first.json.accessToken })).status, 200);
  const reuse = await api('POST', '/auth/refresh', { body: { refreshToken: c.tokens.refreshToken } });
  assert.equal(reuse.json.error.code, 'REFRESH_TOKEN_REUSED');
  assert.equal((await api('GET', '/me', { token: first.json.accessToken })).status, 401);
  assert.equal((await api('POST', '/auth/refresh', { body: { refreshToken: first.json.refreshToken } })).status, 401);

  const fresh = await signIn(c.email);
  assert.equal((await api('POST', '/auth/logout', { token: fresh.accessToken })).status, 204);
  assert.equal((await api('GET', '/me', { token: fresh.accessToken })).status, 401);

  const playground = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  assert.equal((await api('GET', '/me', { token: (await playground.json()).accessToken })).status, 401);
  assert.equal((await api('GET', '/me')).status, 401);
});

test('KYC gates accounts and only stores a masked PAN', async () => {
  const c = await customer({ verified: false });
  assert.equal((await api('POST', '/accounts', { token: c.token, body: { type: 'SAVINGS' } })).status, 403);
  assert.equal((await api('POST', '/kyc', { token: c.token, body: { documents: [{ type: 'PAN', number: 'bad' }] } })).status, 422);
  const submit = await api('POST', '/kyc', { token: c.token, body: { documents: [{ type: 'PAN', number: 'ABCDE1234F' }] } });
  assert.equal(submit.json.status, 'PENDING');
  assert.equal(submit.json.panMasked, 'ABXXXXXX4F');
  assert.equal((await api('POST', '/accounts', { token: c.token, body: { type: 'SAVINGS' } })).status, 403);
  assert.equal((await api('POST', '/kyc', { token: c.token, body: { documents: [{ type: 'PAN', number: 'ABCDE1234F' }] } })).status, 409);
  await wait(50);
  assert.equal((await api('GET', '/kyc', { token: c.token })).json.status, 'VERIFIED');
  assert.equal((await api('POST', '/accounts', { token: c.token, body: { type: 'SAVINGS' } })).status, 201);

  const r = await customer({ verified: false });
  await api('POST', '/kyc', { token: r.token, body: { documents: [{ type: 'PAN', number: 'REJCT1234F' }] } });
  await wait(50);
  assert.equal((await api('GET', '/kyc', { token: r.token })).json.status, 'REJECTED');
  assert.equal((await api('POST', '/accounts', { token: r.token, body: { type: 'SAVINGS' } })).status, 403);
  assert.equal((await api('POST', '/kyc', { token: r.token, body: { documents: [{ type: 'PAN', number: 'ABCDE1234F' }] } })).status, 202);
});

test("customers can't reach each other's data, by any route", async () => {
  const a = await customer();
  const b = await customer();
  const accountA = await open(a);
  await deposit(a, accountA, 500000);
  const accountB = await open(b);
  const benA = await beneficiary(a, accountB.accountNumber);
  const trf = await send(a, accountA, benA, 1000);
  assert.equal(trf.status, 201);
  for (const [m, p, body] of [
    ['GET', `/accounts/${accountA.id}`], ['GET', `/accounts/${accountA.id}/balance`], ['GET', `/accounts/${accountA.id}/transactions`],
    ['GET', `/accounts/${accountA.id}/statement`], ['POST', `/accounts/${accountA.id}/freeze`], ['POST', `/accounts/${accountA.id}/close`],
    ['PATCH', `/accounts/${accountA.id}/limits`, { dailyTransferLimit: 100 }], ['GET', `/beneficiaries/${benA.id}`], ['DELETE', `/beneficiaries/${benA.id}`], ['GET', `/transfers/${trf.json.id}`],
  ]) assert.equal((await api(m, p, { token: b.token, body })).status, 404, `${m} ${p}`);
  const steal = await api('POST', '/transfers', { token: b.token, headers: { 'Idempotency-Key': key() }, body: { fromAccountId: accountA.id, beneficiaryId: benA.id, amount: { value: 100, currency: 'INR' }, mode: 'IMPS' } });
  assert.equal(steal.status, 404);
  assert.equal((await api('GET', '/transfers', { token: b.token })).json.meta.total, 0);
  assert.equal(await balance(a, accountA), 499000);
  assert.equal(await balance(b, accountB), 1000);
  const missing = await api('GET', '/accounts/ACT-999999', { token: b.token });
  const hidden = await api('GET', `/accounts/${accountA.id}`, { token: b.token });
  assert.equal(missing.json.error.code, hidden.json.error.code);
});

test('20 parallel identical transfers debit once, and the other customer is credited once', async () => {
  const a = await customer();
  const b = await customer();
  const from = await open(a);
  const to = await open(b);
  await deposit(a, from, 1000000);
  const ben = await beneficiary(a, to.accountNumber);
  const k = key();
  const results = await Promise.all(Array.from({ length: 20 }, () => send(a, from, ben, 25000, 'IMPS', k)));
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 19);
  const again = await send(a, from, ben, 25000, 'IMPS', k);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(await balance(a, from), 975000);
  assert.equal(await balance(b, to), 25000);
  assert.equal((await send(a, from, ben, 99, 'IMPS', k)).json.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('many different parallel transfers can never overdraw', async () => {
  const a = await customer();
  const from = await open(a);
  const second = await open(a);
  await deposit(a, from, 100000);
  const ben = await beneficiary(a, second.accountNumber);
  const results = await Promise.all(Array.from({ length: 10 }, () => send(a, from, ben, 30000)));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal(results.filter((r) => r.json?.error?.code === 'INSUFFICIENT_FUNDS').length, 7);
  assert.equal(await balance(a, from), 10000);
  assert.equal(await balance(a, second), 90000);
});

test('code approval: boundary, no early debit, second confirm safe, wrong codes cancel', async () => {
  const a = await customer();
  const from = await open(a);
  const second = await open(a);
  await deposit(a, from, 100000000);
  const ben = await beneficiary(a, second.accountNumber);
  assert.equal((await send(a, from, ben, 5000000)).status, 201);
  const big = await send(a, from, ben, 5000001);
  assert.equal(big.status, 202);
  assert.equal(big.json.status, 'PENDING_OTP');
  assert.equal(await balance(a, from), 95000000);
  const ok = await api('POST', `/transfers/${big.json.id}/confirm`, { token: a.token, body: { otp: big.json.devOtp } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'SETTLED');
  assert.doesNotMatch(ok.text, /devOtp/);
  assert.equal(await balance(a, from), 89999999);
  assert.equal((await api('POST', `/transfers/${big.json.id}/confirm`, { token: a.token, body: { otp: big.json.devOtp } })).status, 409);
  assert.equal(await balance(a, from), 89999999);

  const other = await send(a, from, ben, 6000000);
  const bad = other.json.devOtp === '000000' ? '000001' : '000000';
  for (let i = 0; i < 3; i += 1) assert.equal((await api('POST', `/transfers/${other.json.id}/confirm`, { token: a.token, body: { otp: bad } })).status, 401);
  assert.equal((await api('GET', `/transfers/${other.json.id}`, { token: a.token })).json.status, 'FAILED');
  assert.equal((await api('POST', `/transfers/${other.json.id}/confirm`, { token: a.token, body: { otp: other.json.devOtp } })).status, 409);
  assert.equal(await balance(a, from), 89999999);

  const stale = await send(a, from, ben, 6000000);
  await api('POST', `/accounts/${from.id}/freeze`, { token: a.token });
  const frozen = await api('POST', `/transfers/${stale.json.id}/confirm`, { token: a.token, body: { otp: stale.json.devOtp } });
  assert.equal(frozen.json.error.code, 'ACCOUNT_FROZEN');
  assert.equal(await balance(a, from), 89999999);
});

test('NEFT settles later, a rejected one refunds, and limits and modes apply', async () => {
  const a = await customer();
  const from = await open(a);
  await deposit(a, from, 100000000);
  const good = await beneficiary(a, '123456781234', 'HDFC0001234');
  const bad = await beneficiary(a, '123456780000', 'HDFC0001234');

  const ok = await send(a, from, good, 100000, 'NEFT');
  assert.equal(ok.status, 202);
  assert.equal(ok.json.status, 'PROCESSING');
  assert.equal(await balance(a, from), 99900000);

  const rev = await send(a, from, bad, 100000, 'NEFT');
  assert.equal(rev.json.status, 'PROCESSING');
  assert.equal(await balance(a, from), 99800000);
  await wait(120);
  assert.equal((await api('GET', `/transfers/${ok.json.id}`, { token: a.token })).json.status, 'SETTLED');
  const final = await api('GET', `/transfers/${rev.json.id}`, { token: a.token });
  assert.equal(final.json.status, 'REVERSED');
  assert.ok(final.json.failureReason);
  assert.equal(await balance(a, from), 99900000);
  const refund = await api('GET', `/accounts/${from.id}/transactions?category=REVERSAL`, { token: a.token });
  assert.equal(refund.json.meta.total, 1);
  assert.equal(refund.json.data[0].reference, rev.json.id);

  assert.equal((await send(a, from, good, 19999999, 'RTGS')).json.error.code, 'MODE_LIMIT_EXCEEDED');
  assert.equal((await send(a, from, good, 50000001, 'IMPS')).json.error.code, 'MODE_LIMIT_EXCEEDED');
  assert.equal((await send(a, from, good, 100, 'INTERNAL')).json.error.code, 'MODE_NOT_AVAILABLE');

  await api('PATCH', `/accounts/${from.id}/limits`, { token: a.token, body: { dailyTransferLimit: 150000 } });
  assert.equal((await send(a, from, good, 50000)).status, 201); // 100000 already sent today; the reversed one doesn't count.
  const over = await send(a, from, good, 1);
  assert.equal(over.json.error.code, 'DAILY_LIMIT_EXCEEDED');
  assert.equal(over.json.error.details.spentToday, 150000);
});

test('account rules: inactive beneficiary, frozen, closed, validation, replayed failures', async () => {
  const a = await customer();
  const from = await open(a);
  const second = await open(a);
  await deposit(a, from, 100000);
  const pending = await beneficiary(a, second.accountNumber, 'PLAY0000001', false);
  assert.equal((await send(a, from, pending, 100)).json.error.code, 'BENEFICIARY_NOT_ACTIVE');
  assert.equal((await api('POST', '/beneficiaries', { token: a.token, body: { name: 'Dup', accountNumber: second.accountNumber, ifsc: 'PLAY0000001' } })).status, 409);
  assert.equal((await api('POST', '/beneficiaries', { token: a.token, body: { name: 'Ghost', accountNumber: '50100999999999', ifsc: 'PLAY0000001' } })).json.error.code, 'DESTINATION_NOT_FOUND');
  await api('POST', `/beneficiaries/${pending.id}/activate`, { token: a.token, body: { otp: pending.devOtp } });

  assert.equal((await api('POST', '/transfers', { token: a.token, body: {} })).status, 400);
  const invalid = await api('POST', '/transfers', { token: a.token, headers: { 'Idempotency-Key': key() }, body: { amount: { value: -1, currency: 'USD' }, mode: 'SWIFT' } });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.json.error.details.some((d) => d.path === 'amount.value'));

  const k = key();
  const poor = await send(a, from, pending, 200000, 'IMPS', k);
  assert.equal(poor.json.error.code, 'INSUFFICIENT_FUNDS');
  await deposit(a, from, 500000);
  const replay = await send(a, from, pending, 200000, 'IMPS', k);
  assert.equal(replay.json.error.code, 'INSUFFICIENT_FUNDS');
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');

  await api('POST', `/accounts/${from.id}/freeze`, { token: a.token });
  assert.equal((await send(a, from, pending, 100)).json.error.code, 'ACCOUNT_FROZEN');
  assert.equal((await deposit(a, from, 100)).status, 201);
  await api('POST', `/accounts/${from.id}/unfreeze`, { token: a.token });
  assert.equal((await send(a, from, pending, 100)).status, 201);

  assert.equal((await api('POST', `/accounts/${from.id}/close`, { token: a.token })).json.error.code, 'BALANCE_NOT_ZERO');
  const empty = await open(a);
  assert.equal((await api('POST', `/accounts/${empty.id}/close`, { token: a.token })).status, 200);
  assert.equal((await deposit(a, empty, 100)).json.error.code, 'ACCOUNT_CLOSED');

  const destClosed = await open(a);
  const ben2 = await beneficiary(a, destClosed.accountNumber);
  await api('POST', `/accounts/${destClosed.id}/close`, { token: a.token });
  const before = await balance(a, from);
  const toClosed = await send(a, from, ben2, 100);
  assert.equal(toClosed.json.status, 'REVERSED');
  assert.equal(await balance(a, from), before);
});

test('the statement reconciles, the CSV matches, and running balances are consistent', async () => {
  const a = await customer();
  const from = await open(a);
  const second = await open(a);
  await deposit(a, from, 1000000);
  const ben = await beneficiary(a, second.accountNumber);
  await send(a, from, ben, 12345);
  await send(a, from, ben, 111);
  const s = (await api('GET', `/accounts/${from.id}/statement`, { token: a.token })).json;
  assert.equal(s.openingBalance, 0);
  assert.equal(s.totalCredits, 1000000);
  assert.equal(s.totalDebits, 12456);
  assert.equal(s.closingBalance, await balance(a, from));
  let running = s.openingBalance;
  for (const t of s.transactions) {
    running += t.type === 'CREDIT' ? t.amount.value : -t.amount.value;
    assert.equal(t.balanceAfter, running);
  }
  const csv = await api('GET', `/accounts/${from.id}/statement`, { token: a.token, headers: { Accept: 'text/csv' } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.equal(csv.text.trim().split('\n').length, 4);
  const future = (await api('GET', `/accounts/${from.id}/statement?from=2999-01-01&to=2999-12-31`, { token: a.token })).json;
  assert.equal(future.openingBalance, s.closingBalance);
  assert.equal(future.transactions.length, 0);
  assert.equal((await api('GET', `/accounts/${from.id}/statement?from=2026-02-01&to=2026-01-01`, { token: a.token })).status, 400);
});

test('profile updates merge safely, and deleting a customer cleans up', async () => {
  const a = await customer();
  const patched = await api('PATCH', '/me', { token: a.token, body: { address: { city: 'Mumbai' } } });
  assert.equal(patched.json.address.city, 'Mumbai');
  assert.equal(patched.json.address.pincode, '411001');
  assert.equal((await api('PATCH', '/me', { token: a.token, body: { kycStatus: 'VERIFIED' } })).status, 422);
  assert.equal((await api('PATCH', '/me', { token: a.token, body: { isAdmin: true } })).status, 422);
  await open(a);
  assert.equal((await api('DELETE', '/me', { token: a.token })).status, 204);
  assert.equal((await api('GET', '/me', { token: a.token })).status, 401);
  assert.equal((await api('POST', '/auth/register', { body: profile(a.email) })).status, 201);
});
