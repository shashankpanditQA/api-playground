'use strict';
const express = require('express');
const { ApiError, getPath, isObject } = require('../lib');
const { complete } = require('../store');

const router = express.Router();
const MAX_NODES = 5000;

const COMPANY = {
  apiVersion: '2026-01',
  company: {
    id: 'cmp_01',
    legalName: 'Nimbus Retail Pvt. Ltd.',
    localisedNames: { hi: 'निंबस रिटेल', ta: 'நிம்பஸ் ரீடெயில்', emoji: 'Nimbus 🛍️' },
    founded: '2014-08-15',
    isListed: false,
    parentCompany: null,
    tags: [],
    largeIdentifier: '9007199254740993',
    'key.with.dots': 'Read this with a bracket path: $["key.with.dots"]',
    'key with spaces': true,
    headquarters: { city: 'Bengaluru', geo: { lat: 12.9716, lng: 77.5946, accuracyMeters: 12.5 } },
    departments: [
      {
        id: 'dep_eng',
        name: 'Engineering',
        budget: { amount: '125000000.50', currency: 'INR' },
        teams: [
          {
            id: 'team_pay',
            name: 'Payments',
            lead: { id: 'emp_1', name: 'Meera Iyer', manager: null },
            members: [
              {
                id: 'emp_2',
                name: 'Arjun Das',
                active: true,
                skills: [{ name: 'Java', level: 4 }, { name: 'Kafka', level: 3 }],
                contact: { email: 'arjun@nimbus.test', phone: null },
                compensation: { base: 2400000, bonus: { percent: 12.5, paidOn: ['2025-04-01', '2026-04-01'] } },
              },
              {
                id: 'emp_3',
                name: "Sara O'Neil",
                active: false,
                skills: [],
                contact: { email: 'sara@nimbus.test' },
                compensation: { base: 1800000, bonus: null },
              },
            ],
            services: [
              {
                name: 'ledger-api',
                endpoints: [
                  { method: 'POST', path: '/v1/charges', slo: { p99Ms: 400, availability: 99.95 }, auth: { type: 'oauth2', scopes: ['charges:write'] } },
                  { method: 'GET', path: '/v1/charges/{id}', slo: { p99Ms: 120, availability: 99.99 }, auth: { type: 'apiKey', header: 'X-API-Key' } },
                ],
              },
            ],
          },
        ],
      },
      { id: 'dep_ops', name: 'Operations', budget: { amount: '0.00', currency: 'INR' }, teams: [] },
    ],
    // Mixed types on purpose. Use the "type" field to choose the right schema.
    paymentMethods: [
      { type: 'card', network: 'VISA', last4: '4242', expiry: { month: 12, year: 2028 }, threeDSecure: true },
      { type: 'upi', vpa: 'nimbus@okbank', verified: true },
      { type: 'netbanking', bankCode: 'HDFC', account: { maskedNumber: 'XXXX1234', ifsc: 'HDFC0001234' } },
    ],
    matrix: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
    mixedArray: [1, 'two', 3.0, true, null, { six: 6 }, [7]],
  },
};

router.get('/company', (req, res) => {
  res.json(COMPANY);
});

function seededRandom(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

function nodeCount(depth, breadth) {
  let count = 0;
  let level = 1;
  for (let i = 0; i <= depth; i += 1) {
    count += level;
    level *= breadth;
  }
  return count;
}

router.get('/generate', (req, res) => {
  const depth = Number(req.query.depth ?? 3);
  const breadth = Number(req.query.breadth ?? 2);
  const seed = Number(req.query.seed ?? 1);
  if (![depth, breadth, seed].every(Number.isInteger) || depth < 0 || depth > 12 || breadth < 0 || breadth > 10 || seed < 0) {
    throw new ApiError(400, 'INVALID_QUERY', 'depth must be 0 to 12, breadth 0 to 10, and seed a whole number of 0 or more.');
  }
  const nodes = nodeCount(depth, breadth);
  if (nodes > MAX_NODES) throw new ApiError(400, 'TOO_LARGE', `That creates ${nodes} nodes. The limit is ${MAX_NODES}.`);
  const random = seededRandom(seed);
  const build = (level, id) => {
    const node = { id, level, score: Math.round(random() * 1000) / 10, active: random() > 0.3, note: random() > 0.7 ? null : `node-${id}` };
    if (level < depth && breadth > 0) node.children = Array.from({ length: breadth }, (_, i) => build(level + 1, `${id}.${i}`));
    return node;
  };
  complete('complex-generate');
  res.set('X-Node-Count', String(nodes)).json({ seed, depth, breadth, nodeCount: nodes, root: build(0, 'r') });
});

router.post('/extract', (req, res) => {
  const { document, path } = req.body || {};
  if (document === undefined || typeof path !== 'string' || !path) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Send { "document": <any JSON>, "path": "a.b[0].c" }. [*] is supported.', [
      { path: 'path', message: 'must be a non-empty string' },
    ]);
  }
  const found = getPath(document, path);
  if (!found.found) throw new ApiError(404, 'PATH_NOT_FOUND', `Nothing exists at ${path}.`);
  if (path.includes('[*]')) complete('complex-extract');
  res.json({ path, value: found.value, type: found.value === null ? 'null' : Array.isArray(found.value) ? 'array' : typeof found.value });
});

function diff(left, right, at, out) {
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const path = `${at}[${i}]`;
      if (i >= left.length) out.push({ op: 'added', path, right: right[i] });
      else if (i >= right.length) out.push({ op: 'removed', path, left: left[i] });
      else diff(left[i], right[i], path, out);
    }
    return out;
  }
  if (isObject(left) && isObject(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const path = at ? `${at}.${key}` : key;
      if (!Object.prototype.hasOwnProperty.call(left, key)) out.push({ op: 'added', path, right: right[key] });
      else if (!Object.prototype.hasOwnProperty.call(right, key)) out.push({ op: 'removed', path, left: left[key] });
      else diff(left[key], right[key], path, out);
    }
    return out;
  }
  if (left !== right) {
    const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    out.push({ op: typeOf(left) === typeOf(right) ? 'changed' : 'typeChanged', path: at || '$', left, right });
  }
  return out;
}

router.post('/diff', (req, res) => {
  const body = req.body || {};
  if (!('left' in body) || !('right' in body)) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Send { "left": <JSON>, "right": <JSON> }.');
  }
  const differences = diff(body.left, body.right, '', []);
  if (differences.some((d) => d.op === 'typeChanged')) complete('complex-diff');
  res.json({ equal: differences.length === 0, count: differences.length, differences });
});

function validateMethod(item) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!isObject(item)) return [{ path: '$', message: 'must be an object' }];
  switch (item.type) {
    case 'card':
      if (!/^\d{4}$/.test(item.last4 ?? '')) fail('last4', 'must be exactly 4 digits');
      if (!isObject(item.expiry)) fail('expiry', 'must be an object');
      else {
        if (!Number.isInteger(item.expiry.month) || item.expiry.month < 1 || item.expiry.month > 12) fail('expiry.month', 'must be from 1 to 12');
        if (!Number.isInteger(item.expiry.year) || item.expiry.year < 2026) fail('expiry.year', 'must be 2026 or later');
      }
      break;
    case 'upi':
      if (!/^[\w.-]+@[\w.-]+$/.test(item.vpa ?? '')) fail('vpa', 'must look like name@bank');
      break;
    case 'netbanking':
      if (!/^[A-Z]{4}$/.test(item.bankCode ?? '')) fail('bankCode', 'must be 4 capital letters');
      break;
    default:
      fail('type', 'must be card, upi or netbanking');
  }
  return errors;
}

router.post('/batch', (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Send { "items": [ ... ] } with 1 to 100 entries.');
  }
  const results = items.map((item, index) => {
    const errors = validateMethod(item);
    return errors.length
      ? { index, status: 422, error: { code: 'VALIDATION_FAILED', details: errors } }
      : { index, status: 201, data: { id: `pm_${index + 1}`, type: item.type } };
  });
  const succeeded = results.filter((r) => r.status === 201).length;
  const failed = results.length - succeeded;
  if (succeeded && failed) complete('complex-batch');
  // 207 only for a mixed outcome. All-good is 201 and all-bad is 422.
  const status = succeeded && failed ? 207 : failed ? 422 : 201;
  res.status(status).json({ summary: { total: results.length, succeeded, failed }, results });
});

module.exports = router;
