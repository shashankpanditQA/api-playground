'use strict';
const express = require('express');
const { ApiError, sleep } = require('../lib');
const { state, complete } = require('../store');

const router = express.Router();
const jobs = express.Router();

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10000;
const MAX_DELAY_MS = 30000;

router.all('/status/:code', (req, res) => {
  const code = Number(req.params.code);
  if (!Number.isInteger(code) || code < 200 || code > 599) {
    throw new ApiError(400, 'INVALID_STATUS', 'Use a status code from 200 to 599.');
  }
  if ([204, 304].includes(code)) return res.status(code).end();
  if (code >= 300 && code < 400) return res.status(code).set('Location', '/api/simulate/status/200').json({ status: code });
  return res.status(code).json({ status: code, message: `You asked for ${code}.` });
});

router.get('/delay/:ms', async (req, res, next) => {
  try {
    const ms = Number(req.params.ms);
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_DELAY_MS) {
      throw new ApiError(400, 'INVALID_DELAY', `Use a delay from 0 to ${MAX_DELAY_MS} ms.`);
    }
    await sleep(ms);
    res.json({ delayedMs: ms });
  } catch (err) {
    next(err);
  }
});

// Fails the first N calls for a given name, then succeeds: predictable retry testing.
router.get('/flaky/:name', (req, res) => {
  const failTimes = Math.min(Math.max(Number(req.query.failTimes ?? 2) || 0, 0), 20);
  const count = (state.flaky.get(req.params.name) || 0) + 1;
  state.flaky.set(req.params.name, count);
  res.set('X-Attempt', String(count));
  if (count <= failTimes) {
    throw new ApiError(503, 'TEMPORARILY_UNAVAILABLE', `Attempt ${count} failed. ${failTimes - count + 1} failure(s) left.`, { attempt: count, failTimes }, { 'Retry-After': '1' });
  }
  if (failTimes > 0) complete('sim-retry');
  return res.json({ ok: true, attempt: count, succeededAfterFailures: failTimes });
});

router.get('/rate-limited', (req, res) => {
  const client = req.get('x-client-id') || req.ip;
  const now = Date.now();
  let bucket = state.rateLimits.get(client);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    state.rateLimits.set(client, bucket);
  }
  bucket.count += 1;
  const remaining = Math.max(RATE_LIMIT - bucket.count, 0);
  res.set({
    'X-RateLimit-Limit': String(RATE_LIMIT),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(Math.ceil(bucket.resetAt / 1000)),
  });
  if (bucket.count > RATE_LIMIT) {
    complete('sim-rate-limit');
    throw new ApiError(429, 'RATE_LIMITED', `Limit is ${RATE_LIMIT} calls per 10 seconds.`, undefined, {
      'Retry-After': String(Math.ceil((bucket.resetAt - now) / 1000)),
    });
  }
  res.json({ ok: true, remaining });
});

router.get('/malformed', (req, res) => {
  complete('sim-malformed');
  res.status(200).type('application/json').send('{"id": 1, "name": "broken", "items": [1, 2,');
});

router.get('/wrong-content-type', (req, res) => {
  res.status(200).type('text/html').send(JSON.stringify({ looksLike: 'json', butIs: 'labelled text/html' }));
});

router.get('/empty', (req, res) => res.status(200).type('application/json').end());

// The contract silently changes on every other call: can your schema test catch it?
router.get('/schema-drift', (req, res) => {
  state.driftCalls += 1;
  if (state.driftCalls % 2 === 1) return res.json({ id: 42, price: 199.5, inStock: true, tags: ['a', 'b'] });
  complete('sim-schema-drift');
  return res.json({ id: '42', price: '199.50', in_stock: 'yes', tags: null });
});

router.get('/large', (req, res) => {
  const items = Math.min(Math.max(Number(req.query.items ?? 1000) || 1, 1), 50000);
  res.json({ count: items, data: Array.from({ length: items }, (_, i) => ({ id: i + 1, label: `Item ${i + 1}`, even: i % 2 === 1 })) });
});

jobs.post('/', (req, res) => {
  const durationMs = req.body?.durationMs ?? 3000;
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_DELAY_MS) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'The job is invalid.', [{ path: 'durationMs', message: `must be from 0 to ${MAX_DELAY_MS}` }]);
  }
  state.jobSeq += 1;
  const id = `JOB-${state.jobSeq}`;
  state.jobs.set(id, { id, startedAt: Date.now(), durationMs, willFail: req.body?.fail === true });
  res.status(202).set({ Location: `/api/jobs/${id}`, 'Retry-After': '1' }).json({ id, status: 'PENDING', statusUrl: `/api/jobs/${id}` });
});

jobs.get('/:id', (req, res) => {
  const job = state.jobs.get(req.params.id);
  if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', `No job with id ${req.params.id}.`);
  const elapsed = Date.now() - job.startedAt;
  if (elapsed < job.durationMs) {
    return res.set('Retry-After', '1').json({ id: job.id, status: 'RUNNING', progress: Math.floor((elapsed / job.durationMs) * 100) });
  }
  if (job.willFail) return res.json({ id: job.id, status: 'FAILED', error: { code: 'JOB_FAILED', message: 'The job failed as you requested.' } });
  complete('sim-job');
  return res.json({ id: job.id, status: 'COMPLETED', progress: 100, result: { report: `/reports/${job.id}.csv`, rows: 1280 } });
});

module.exports = { simulate: router, jobs };
