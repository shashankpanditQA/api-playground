'use strict';
const crypto = require('crypto');
const express = require('express');
const { ApiError, sleep, clone, getPath, isObject } = require('../lib');
const { state, complete } = require('../store');

const admin = express.Router();
const serve = express.Router();
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'];
const IS_PUBLIC = process.env.PUBLIC_MODE === 'true';
const MAX_CALLS = IS_PUBLIC ? 20 : 100;
const MAX_MOCKS = IS_PUBLIC ? 50 : 1000;
const MAX_DELAY_MS = 30000;

function validateMock(body) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!isObject(body)) return [{ path: '$', message: 'body must be a JSON object' }];
  if (!METHODS.includes(String(body.method).toUpperCase())) fail('method', `must be one of ${METHODS.join(', ')}`);
  if (typeof body.path !== 'string' || !body.path.startsWith('/')) fail('path', 'must start with / such as /users/:id. It is served under /mock');
  const hasOne = isObject(body.response);
  const hasMany = Array.isArray(body.responses) && body.responses.length > 0;
  if (hasOne === hasMany) fail('response', 'send either response or a non-empty responses array, not both');
  const list = hasMany ? body.responses : hasOne ? [body.response] : [];
  list.forEach((r, i) => {
    const at = hasMany ? `responses[${i}]` : 'response';
    if (!Number.isInteger(r?.status) || r.status < 200 || r.status > 599) fail(`${at}.status`, 'must be from 200 to 599');
    if (r?.headers !== undefined && !isObject(r.headers)) fail(`${at}.headers`, 'must be an object');
    if (r?.delayMs !== undefined && (!Number.isInteger(r.delayMs) || r.delayMs < 0 || r.delayMs > MAX_DELAY_MS)) fail(`${at}.delayMs`, `must be from 0 to ${MAX_DELAY_MS}`);
  });
  if (body.afterLast !== undefined && !['repeatLast', 'loop'].includes(body.afterLast)) fail('afterLast', 'must be repeatLast or loop');
  if (body.match !== undefined && !isObject(body.match)) fail('match', 'must be an object with any of query, headers, body');
  return errors;
}

function compilePath(pattern) {
  const names = [];
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z_]\w*)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${escaped}/?$`), names };
}

function matchPath(pattern, actual) {
  const { regex, names } = compilePath(pattern);
  const result = regex.exec(actual);
  if (!result) return null;
  return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(result[i + 1])]));
}

/** True when every value in `expected` appears in `actual`. Extra fields are allowed. */
function isSubset(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((value, i) => isSubset(value, actual[i]));
  }
  if (isObject(expected)) {
    return isObject(actual) && Object.entries(expected).every(([k, v]) => Object.prototype.hasOwnProperty.call(actual, k) && isSubset(v, actual[k]));
  }
  return String(expected) === String(actual);
}

function matchFailure(mock, req) {
  const { query, headers, body } = mock.match || {};
  if (query && !isSubset(query, req.query)) return 'query';
  if (headers) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (!isSubset(lower, req.headers)) return 'headers';
  }
  if (body && !isSubset(body, req.body)) return 'body';
  return null;
}

function renderString(text, context) {
  const lookup = (expression) => {
    if (expression === 'uuid') return crypto.randomUUID();
    if (expression === 'now') return new Date().toISOString();
    if (expression === 'timestamp') return Math.floor(Date.now() / 1000);
    if (expression === 'randomInt') return crypto.randomInt(0, 1000000);
    const found = getPath(context, expression);
    return found.found ? found.value : null;
  };
  const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(text);
  if (whole) return lookup(whole[1]);
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, expression) => {
    const value = lookup(expression);
    return value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

function render(value, context) {
  if (typeof value === 'string') return renderString(value, context);
  if (Array.isArray(value)) return value.map((v) => render(v, context));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, context)]));
  return value;
}

const summary = ({ calls, ...mock }) => ({ ...mock, url: `/mock${mock.path}`, callCount: calls.length });

function findMock(id) {
  const mock = state.mocks.find((m) => m.id === id);
  if (!mock) throw new ApiError(404, 'MOCK_NOT_FOUND', `No mock with id ${id}.`);
  return mock;
}

admin.get('/', (req, res) => res.json({ data: state.mocks.map(summary) }));

admin.post('/', (req, res) => {
  const errors = validateMock(req.body);
  if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', `The mock has ${errors.length} invalid field(s).`, errors);
  if (state.mocks.length >= MAX_MOCKS) {
    throw new ApiError(409, 'TOO_MANY_MOCKS', `The limit is ${MAX_MOCKS} mocks. Delete some with DELETE /api/mocks.`);
  }
  state.mockSeq += 1;
  const { name, method, path, priority = 0, match = {}, response, responses, afterLast = 'repeatLast' } = req.body;
  const mock = {
    id: `mock_${state.mockSeq}`,
    name: name ?? `${String(method).toUpperCase()} ${path}`,
    method: String(method).toUpperCase(),
    path,
    priority,
    match,
    responses: clone(responses ?? [response]),
    afterLast,
    hits: 0,
    calls: [],
    createdAt: new Date().toISOString(),
  };
  state.mocks.push(mock);
  complete('mock-create');
  res.status(201).set('Location', `/api/mocks/${mock.id}`).json(summary(mock));
});

admin.get('/:id', (req, res) => res.json(summary(findMock(req.params.id))));

admin.get('/:id/calls', (req, res) => {
  const mock = findMock(req.params.id);
  if (mock.calls.length > 0) complete('mock-verify');
  res.json({ mockId: mock.id, callCount: mock.calls.length, calls: mock.calls });
});

admin.post('/:id/reset', (req, res) => {
  const mock = findMock(req.params.id);
  mock.hits = 0;
  mock.calls = [];
  res.json(summary(mock));
});

admin.delete('/:id', (req, res) => {
  findMock(req.params.id);
  state.mocks = state.mocks.filter((m) => m.id !== req.params.id);
  res.status(204).end();
});

admin.delete('/', (req, res) => {
  state.mocks = [];
  res.status(204).end();
});

serve.all('*', async (req, res, next) => {
  try {
    const candidates = [];
    const near = [];
    for (const mock of state.mocks) {
      const params = matchPath(mock.path, req.path);
      if (!params) continue;
      if (mock.method !== 'ANY' && mock.method !== req.method) {
        near.push({ id: mock.id, reason: `method is ${mock.method}` });
        continue;
      }
      const failed = matchFailure(mock, req);
      if (failed) {
        near.push({ id: mock.id, reason: `${failed} did not match`, expected: mock.match[failed] });
        continue;
      }
      candidates.push({ mock, params });
    }
    if (!candidates.length) {
      throw new ApiError(404, 'NO_MOCK_MATCHED', `No mock matches ${req.method} ${req.path}.`, { nearMisses: near });
    }
    candidates.sort((a, b) => b.mock.priority - a.mock.priority || state.mocks.indexOf(b.mock) - state.mocks.indexOf(a.mock));
    const { mock, params } = candidates[0];

    const index = mock.afterLast === 'loop' ? mock.hits % mock.responses.length : Math.min(mock.hits, mock.responses.length - 1);
    const planned = mock.responses[index];
    mock.hits += 1;
    mock.calls.push({ at: new Date().toISOString(), method: req.method, path: req.path, query: req.query, headers: req.headers, body: req.body ?? null, respondedWith: planned.status });
    if (mock.calls.length > MAX_CALLS) mock.calls.shift();

    const context = { params, query: req.query, headers: req.headers, body: req.body ?? {} };
    const template = JSON.stringify(planned.body ?? null);
    if (/\{\{\s*(params|query|headers|body)\./.test(template)) complete('mock-template');
    if (mock.responses.length > 1 && mock.hits >= 2 && mock.responses[index].status !== mock.responses[index - 1]?.status) complete('mock-sequence');
    if (Object.keys(mock.match).length) complete('mock-conditional');

    if (planned.delayMs) await sleep(planned.delayMs);
    res.set('X-Mock-Id', mock.id);
    if (planned.headers) res.set(render(planned.headers, context));
    // On a public URL, a mock must not be able to act as a real web page on this domain.
    if (IS_PUBLIC) res.set({ 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff' });
    if (planned.body === undefined || planned.body === null) return res.status(planned.status).end();
    const body = render(planned.body, context);
    return typeof body === 'string' ? res.status(planned.status).send(body) : res.status(planned.status).json(body);
  } catch (err) {
    return next(err);
  }
});

module.exports = { mockAdmin: admin, mockServe: serve };
