'use strict';
const crypto = require('crypto');
const { complete } = require('./store');

const JWT_SECRET = process.env.JWT_SECRET || 'playground-jwt-secret';
const API_KEY = 'pk_test_playground';
const SIGNING_SECRET = 'playground-signing-secret';

const USERS = {
  admin: { password: 'admin123', role: 'admin' },
  tester: { password: 'tester123', role: 'tester' },
  viewer: { password: 'viewer123', role: 'viewer' },
};

class ApiError extends Error {
  constructor(status, code, message, details, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

const b64url = (input) => Buffer.from(input).toString('base64url');

function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyJwt(token) {
  const [head, body, sig] = String(token).split('.');
  if (!head || !body || !sig) return { error: 'TOKEN_MALFORMED' };
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  if (!safeEqual(sig, expected)) return { error: 'TOKEN_INVALID' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return { error: 'TOKEN_MALFORMED' };
  }
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return { error: 'TOKEN_EXPIRED', payload };
  return { payload };
}

function authenticate(req, res, next) {
  const challenge = { 'WWW-Authenticate': 'Bearer realm="api-playground"' };
  const apiKey = req.get('x-api-key');
  if (apiKey) {
    if (!safeEqual(apiKey, API_KEY)) {
      return next(new ApiError(401, 'API_KEY_INVALID', 'The X-API-Key value is not recognised.', undefined, challenge));
    }
    req.user = { username: 'tester', role: 'tester', via: 'api-key' };
    return next();
  }
  const header = req.get('authorization');
  if (!header) {
    complete('auth-401');
    return next(
      new ApiError(401, 'AUTH_REQUIRED', 'Send Authorization: Bearer <token> or X-API-Key.', undefined, challenge)
    );
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return next(new ApiError(401, 'AUTH_SCHEME_INVALID', 'Only the Bearer scheme is supported.', undefined, challenge));
  const result = verifyJwt(match[1]);
  if (result.error) {
    if (result.error === 'TOKEN_EXPIRED') complete('auth-expired');
    return next(new ApiError(401, result.error, 'The bearer token was rejected.', undefined, challenge));
  }
  req.user = { username: result.payload.sub, role: result.payload.role, via: 'jwt' };
  return next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (roles.includes(req.user.role)) return next();
  complete('auth-403');
  return next(
    new ApiError(403, 'FORBIDDEN', `Role "${req.user.role}" cannot do this. Allowed: ${roles.join(', ')}.`, {
      requiredRoles: roles,
      yourRole: req.user.role,
    })
  );
};

/** Stable JSON: the same object produces the same text whatever its key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Reads a.b[0].c, supports [*] wildcards. Returns { found, value }. */
function getPath(document, path) {
  const tokens = String(path).match(/[^.[\]]+|\[\*\]|\[\d+\]/g) || [];
  const walk = (node, index) => {
    if (index === tokens.length) return { found: true, value: node };
    const token = tokens[index];
    if (token === '[*]') {
      if (!Array.isArray(node)) return { found: false };
      const results = node.map((n) => walk(n, index + 1)).filter((r) => r.found);
      return { found: true, value: results.flatMap((r) => (tokens.slice(index + 1).includes('[*]') ? r.value : [r.value])) };
    }
    if (token.startsWith('[')) {
      if (!Array.isArray(node)) return { found: false };
      const i = Number(token.slice(1, -1));
      return i < node.length ? walk(node[i], index + 1) : { found: false };
    }
    if (!isObject(node) || !Object.prototype.hasOwnProperty.call(node, token)) return { found: false };
    return walk(node[token], index + 1);
  };
  return walk(document, 0);
}

/** RFC 7386 JSON Merge Patch. */
function mergePatch(target, patch) {
  if (!isObject(patch)) return patch;
  const result = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

module.exports = {
  API_KEY,
  SIGNING_SECRET,
  USERS,
  ApiError,
  signJwt,
  verifyJwt,
  safeEqual,
  authenticate,
  requireRole,
  canonical,
  sha256,
  sleep,
  clone,
  isObject,
  getPath,
  mergePatch,
};
