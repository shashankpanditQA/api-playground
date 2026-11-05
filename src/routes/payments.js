'use strict';
const express = require('express');
const { ApiError, authenticate, requireRole, canonical, sha256, sleep, clone, isObject } = require('../lib');
const { state, complete } = require('../store');

const router = express.Router();

const TTL_MS = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400) * 1000;
const PROCESSING_MS = Number(process.env.PAYMENT_PROCESSING_MS || 150);
const SLOW_MS = Number(process.env.PAYMENT_SLOW_MS || 3000);
const KEY_PATTERN = /^[\w:.-]{8,128}$/;

const TOKENS = {
  tok_success: 'Charge succeeds.',
  tok_declined: 'Bank declines: 402. The result is stored and replayed.',
  tok_slow: 'Takes 3 seconds, so you can send a second request while the first is running.',
  tok_timeout_after_charge: 'Money moves, but this first response is a 504. A retry with the same key must not charge again.',
  tok_server_error_once: 'First attempt fails with a 500 before any money moves. A retry with the same key succeeds.',
};

function validatePayment(body) {
  const errors = [];
  const fail = (path, message, received) => errors.push({ path, message, received: received === undefined ? null : received });
  if (!isObject(body)) return [{ path: '$', message: 'body must be a JSON object', received: body }];
  if (!isObject(body.amount)) fail('amount', 'must be an object', body.amount);
  else {
    if (!Number.isInteger(body.amount.value) || body.amount.value < 1) fail('amount.value', 'must be a positive whole number of paise', body.amount.value);
    if (body.amount.currency !== 'INR') fail('amount.currency', 'must be INR', body.amount.currency);
  }
  if (!isObject(body.source)) fail('source', 'must be an object', body.source);
  else {
    if (typeof body.source.accountId !== 'string') fail('source.accountId', 'must be a string', body.source.accountId);
    if (!Object.prototype.hasOwnProperty.call(TOKENS, body.source.token)) fail('source.token', `must be one of ${Object.keys(TOKENS).join(', ')}`, body.source.token);
  }
  if (!isObject(body.destination) || typeof body.destination.accountId !== 'string') {
    fail('destination.accountId', 'must be a string', body.destination?.accountId);
  }
  return errors;
}

function checkAccounts(body) {
  for (const [path, id] of [['source.accountId', body.source.accountId], ['destination.accountId', body.destination.accountId]]) {
    if (!state.accounts.has(id)) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', `No account with id ${id}.`, { path });
  }
  if (body.source.accountId === body.destination.accountId) {
    throw new ApiError(422, 'SAME_ACCOUNT', 'Source and destination must be different accounts.');
  }
}

function postLedger(accountId, amount, type, reference) {
  const account = state.accounts.get(accountId);
  account.balance += amount;
  state.ledger.push({ id: `LED-${state.ledger.length + 1}`, accountId, amount, type, reference, balanceAfter: account.balance, at: new Date().toISOString() });
}

function charge(body) {
  const { amount, source, destination, metadata } = body;
  const now = new Date().toISOString();
  state.paymentSeq += 1;
  const payment = {
    id: `PAY-${String(state.paymentSeq).padStart(5, '0')}`,
    status: 'SUCCEEDED',
    amount,
    source,
    destination,
    metadata: metadata ?? {},
    refundedAmount: 0,
    refunds: [],
    createdAt: now,
  };
  if (source.token === 'tok_declined' || state.accounts.get(source.accountId).balance < amount.value) {
    payment.status = 'FAILED';
    payment.failure = source.token === 'tok_declined'
      ? { code: 'CARD_DECLINED', message: 'The bank declined this charge.' }
      : { code: 'INSUFFICIENT_FUNDS', message: 'The source account balance is too low.' };
    state.payments.set(payment.id, payment);
    return { status: 402, body: clone(payment) };
  }
  postLedger(source.accountId, -amount.value, 'DEBIT', payment.id);
  postLedger(destination.accountId, amount.value, 'CREDIT', payment.id);
  state.payments.set(payment.id, payment);
  return { status: 201, body: clone(payment), headers: { Location: `/api/payments/${payment.id}` } };
}

/**
 * Wraps a money-moving operation in the Idempotency-Key protocol.
 * execute() returns { status, body, headers, surfaced? }: the record stores the true
 * outcome, and `surfaced` is what the first caller sees if that differs.
 */
function idempotent({ validate, execute, simulate }) {
  return async (req, res, next) => {
    try {
      const key = req.get('idempotency-key');
      if (!key) {
        complete('idem-missing');
        throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header with this request.');
      }
      if (!KEY_PATTERN.test(key)) {
        throw new ApiError(400, 'IDEMPOTENCY_KEY_INVALID', 'The key must be 8 to 128 characters: letters, numbers, _ - : or .');
      }
      validate(req);

      const scoped = `${req.user.username}:${key}`;
      const fingerprint = sha256(`${req.method} ${req.path} ${req.baseUrl} ${canonical(req.body)}`);
      let record = state.idempotency.get(scoped);
      if (record && record.expiresAt <= Date.now()) {
        state.idempotency.delete(scoped);
        record = null;
      }

      res.set('Idempotency-Key', key);
      if (record) {
        if (record.fingerprint !== fingerprint) {
          complete('idem-conflict');
          throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This key was already used with a different request. Use a new key for a new payment.');
        }
        if (record.state === 'PROCESSING') {
          complete('idem-inflight');
          throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The first request with this key is still running. Retry shortly.', undefined, { 'Retry-After': '1' });
        }
        complete('idem-replay');
        if (req.body?.source?.token === 'tok_timeout_after_charge') complete('idem-timeout');
        res.set({ 'Idempotent-Replayed': 'true', 'X-Original-Request-Id': record.requestId, ...record.headers });
        return res.status(record.status).json(record.body);
      }

      const created = Date.now();
      record = { key, state: 'PROCESSING', fingerprint, requestId: req.id, createdAt: new Date(created).toISOString(), expiresAt: created + TTL_MS };
      state.idempotency.set(scoped, record);
      res.set('Idempotent-Replayed', 'false');

      const token = req.body?.source?.token;
      await sleep(token === 'tok_slow' ? SLOW_MS : PROCESSING_MS);

      if (token === 'tok_server_error_once' && !state.failedOnce.has(scoped)) {
        state.failedOnce.add(scoped);
        state.idempotency.delete(scoped);
        throw new ApiError(500, 'GATEWAY_ERROR', 'The gateway failed before any money moved. Retry with the same key.');
      }
      if (token === 'tok_server_error_once') complete('idem-server-error');

      const result = execute(req);
      Object.assign(record, { state: 'COMPLETED', status: result.status, body: result.body, headers: result.headers || {} });

      const surfaced = simulate?.(req);
      if (surfaced) throw surfaced;
      res.set(record.headers);
      return res.status(result.status).json(result.body);
    } catch (err) {
      return next(err);
    }
  };
}

router.get('/test-tokens', (req, res) => res.json({ tokens: TOKENS }));

router.use(authenticate);

router.post('/unsafe', requireRole('admin', 'tester'), (req, res) => {
  const errors = validatePayment(req.body);
  if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', `The payment has ${errors.length} invalid field(s).`, errors);
  checkAccounts(req.body);
  const signature = canonical(req.body);
  if (state.lastUnsafe === signature) complete('idem-unsafe');
  state.lastUnsafe = signature;
  const result = charge(req.body);
  res.set('X-Warning', 'This endpoint has no duplicate protection. Compare it with POST /api/payments.');
  res.status(result.status).json(result.body);
});

router.post(
  '/',
  requireRole('admin', 'tester'),
  idempotent({
    validate(req) {
      const errors = validatePayment(req.body);
      if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', `The payment has ${errors.length} invalid field(s).`, errors);
      checkAccounts(req.body);
    },
    execute: (req) => charge(req.body),
    simulate(req) {
      if (req.body.source.token !== 'tok_timeout_after_charge') return null;
      return new ApiError(504, 'GATEWAY_TIMEOUT', 'Your client saw a timeout, but the charge may have gone through. Retry with the same key.');
    },
  })
);

router.get('/', (req, res) => {
  let rows = [...state.payments.values()];
  if (req.query.status) rows = rows.filter((p) => p.status === req.query.status);
  if (req.query.accountId) rows = rows.filter((p) => p.source.accountId === req.query.accountId);
  res.json({ data: rows, meta: { total: rows.length } });
});

function findPayment(id) {
  const payment = state.payments.get(id);
  if (!payment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', `No payment with id ${id}.`);
  return payment;
}

router.get('/:id', (req, res) => res.json(findPayment(req.params.id)));

router.post(
  '/:id/refunds',
  requireRole('admin', 'tester'),
  idempotent({
    validate(req) {
      findPayment(req.params.id);
      const value = req.body?.amount?.value;
      if (!Number.isInteger(value) || value < 1) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'The refund is invalid.', [{ path: 'amount.value', message: 'must be a positive whole number of paise', received: value ?? null }]);
      }
    },
    execute(req) {
      const payment = findPayment(req.params.id);
      const value = req.body.amount.value;
      const remaining = payment.amount.value - payment.refundedAmount;
      if (payment.status !== 'SUCCEEDED') {
        return { status: 409, body: { error: { code: 'PAYMENT_NOT_REFUNDABLE', message: `A ${payment.status} payment cannot be refunded.` } } };
      }
      if (value > remaining) {
        complete('idem-overrefund');
        return { status: 422, body: { error: { code: 'REFUND_EXCEEDS_PAYMENT', message: 'The refund is larger than the amount left on this payment.', details: { requested: value, remaining } } } };
      }
      state.refundSeq += 1;
      const refund = { id: `REF-${String(state.refundSeq).padStart(5, '0')}`, paymentId: payment.id, amount: { value, currency: 'INR' }, reason: req.body.reason ?? null, createdAt: new Date().toISOString() };
      postLedger(payment.destination.accountId, -value, 'REFUND_DEBIT', refund.id);
      postLedger(payment.source.accountId, value, 'REFUND_CREDIT', refund.id);
      payment.refundedAmount += value;
      payment.refunds.push(refund);
      return { status: 201, body: clone(refund) };
    },
  })
);

const accounts = express.Router();
accounts.use(authenticate);
accounts.get('/', (req, res) => res.json({ data: [...state.accounts.values()] }));

function findAccount(id) {
  const account = state.accounts.get(id);
  if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', `No account with id ${id}.`);
  return account;
}

accounts.get('/:id', (req, res) => res.json(findAccount(req.params.id)));
accounts.get('/:id/ledger', (req, res) => {
  const account = findAccount(req.params.id);
  const entries = state.ledger.filter((entry) => entry.accountId === account.id);
  res.json({ account, entries, meta: { total: entries.length } });
});

const keys = express.Router();
keys.use(authenticate);
keys.get('/:key', (req, res) => {
  const record = state.idempotency.get(`${req.user.username}:${req.params.key}`);
  if (!record) throw new ApiError(404, 'IDEMPOTENCY_KEY_NOT_FOUND', 'This key is not stored. It was never used, or its attempt failed before completing.');
  res.json({ key: record.key, state: record.state, storedStatus: record.status ?? null, firstRequestId: record.requestId, createdAt: record.createdAt, expiresAt: new Date(record.expiresAt).toISOString() });
});

module.exports = { payments: router, accounts, idempotencyKeys: keys };
