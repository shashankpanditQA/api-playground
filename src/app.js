'use strict';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const { ApiError } = require('./lib');
const { state, resetData, progress, clearProgress } = require('./store');
const challenges = require('./challenges');
const openapi = require('./openapi');
const authRoutes = require('./routes/auth');
const headerRoutes = require('./routes/headers');
const orderRoutes = require('./routes/orders');
const { payments, accounts, idempotencyKeys } = require('./routes/payments');
const { mockAdmin, mockServe } = require('./routes/mocks');
const { simulate, jobs } = require('./routes/simulate');
const complexRoutes = require('./routes/complex');

/** Limits that only apply when the app runs on a public URL. */
function publicGuard() {
  const limit = Number(process.env.PUBLIC_RATE_LIMIT || 600);
  const hits = new Map();
  return (req, res, next) => {
    if (req.path === '/health') return next();
    const now = Date.now();
    if (hits.size > 10000) hits.clear();
    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 60000 };
      hits.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      return next(new ApiError(429, 'PLATFORM_RATE_LIMITED', `This public server allows ${limit} requests per minute.`, undefined, {
        'Retry-After': String(Math.ceil((entry.resetAt - now) / 1000)),
      }));
    }
    const stored = state.payments.size + state.orders.size + state.idempotency.size + state.flaky.size + state.rateLimits.size + state.jobs.size;
    if (stored > Number(process.env.PUBLIC_MAX_RECORDS || 2000)) resetData();
    return next();
  };
}

function createApp() {
  const isPublic = process.env.PUBLIC_MODE === 'true';
  const app = express();
  app.disable('x-powered-by');
  if (isPublic) app.set('trust proxy', 1);
  app.set('json spaces', 2);
  app.set('etag', false);

  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomUUID();
    const started = process.hrtime.bigint();
    res.set('X-Request-Id', req.id);
    const writeHead = res.writeHead;
    res.writeHead = function patched(...args) {
      if (!res.headersSent) res.set('X-Response-Time-Ms', (Number(process.hrtime.bigint() - started) / 1e6).toFixed(1));
      return writeHead.apply(this, args);
    };
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
    });
    if (req.method === 'OPTIONS' && !req.path.startsWith('/mock')) return res.status(204).end();
    return next();
  });

  if (isPublic) app.use(publicGuard());

  app.use(
    express.json({
      limit: isPublic ? '50kb' : '1mb',
      strict: false,
      type: ['application/json', 'application/*+json'],
      verify: (req, res, buffer) => {
        req.rawBody = buffer;
      },
    })
  );

  app.get('/health', (req, res) => res.json({ status: 'UP', uptimeSeconds: Math.round(process.uptime()) }));
  app.get('/openapi.json', (req, res) => res.json(openapi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'API Playground docs' }));

  app.use('/api/auth', authRoutes);
  app.use('/api/headers', headerRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/payments', payments);
  app.use('/api/accounts', accounts);
  app.use('/api/idempotency-keys', idempotencyKeys);
  app.use('/api/mocks', mockAdmin);
  app.use('/mock', mockServe);
  app.use('/api/simulate', simulate);
  app.use('/api/jobs', jobs);
  app.use('/api/complex', complexRoutes);

  app.get('/api/challenges', (req, res) => {
    const data = challenges.map((c) => ({ ...c, completedAt: progress[c.id] || null }));
    res.json({ data, meta: { total: data.length, completed: data.filter((c) => c.completedAt).length } });
  });

  app.post('/api/admin/reset', (req, res) => {
    resetData();
    const wipeProgress = req.query.progress === 'true';
    if (wipeProgress) clearProgress();
    res.json({ reset: true, progressCleared: wipeProgress });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((req, res, next) => {
    next(new ApiError(404, 'ROUTE_NOT_FOUND', `${req.method} ${req.path} does not exist. See /docs.`));
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let error = err;
    if (err.type === 'entity.parse.failed') {
      error = new ApiError(400, 'INVALID_JSON', `The body is not valid JSON: ${err.message}`);
    } else if (err.type === 'entity.too.large') {
      error = new ApiError(413, 'BODY_TOO_LARGE', `The body is larger than the ${isPublic ? '50 KB' : '1 MB'} limit.`);
    } else if (!(err instanceof ApiError)) {
      console.error(err);
      error = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong on the server.');
    }
    if (error.headers) res.set(error.headers);
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details ?? null, requestId: req.id },
    });
  });

  return app;
}

module.exports = { createApp };
