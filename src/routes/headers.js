'use strict';
const crypto = require('crypto');
const express = require('express');
const { ApiError, SIGNING_SECRET, safeEqual, authenticate } = require('../lib');
const { complete } = require('../store');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER = /^\d+\.\d+\.\d+$/;
const FIVE_MINUTES = 5 * 60;

const sign = (timestamp, payload) =>
  `sha256=${crypto.createHmac('sha256', SIGNING_SECRET).update(`${timestamp}.${payload}`).digest('hex')}`;

router.all('/echo', (req, res) => {
  res.json({
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    bodyBytes: req.rawBody ? req.rawBody.length : 0,
    body: req.body ?? null,
  });
});

router.post('/validate', (req, res) => {
  const violations = [];
  const add = (header, expected) => violations.push({ header, expected, received: req.get(header) ?? null });

  if (!/^application\/json\b/i.test(req.get('content-type') || '')) add('Content-Type', 'application/json');
  if (!/application\/json/i.test(req.get('accept') || '')) add('Accept', 'must include application/json');
  if (!UUID.test(req.get('x-request-id') || '')) add('X-Request-Id', 'a UUID');
  if (!SEMVER.test(req.get('x-client-version') || '')) add('X-Client-Version', 'semantic version such as 1.4.2');
  if (!['web', 'ios', 'android'].includes(req.get('x-client-platform'))) add('X-Client-Platform', 'web, ios or android');
  const timestamp = Number(req.get('x-timestamp'));
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > FIVE_MINUTES) {
    add('X-Timestamp', 'Unix time in seconds, within 5 minutes of the server clock');
  }

  if (violations.length) {
    if (violations.length >= 3) complete('headers-multi-fail');
    throw new ApiError(400, 'HEADER_VALIDATION_FAILED', `${violations.length} header rule(s) failed.`, violations);
  }
  complete('headers-pass');
  res.json({ valid: true, serverTime: Math.floor(Date.now() / 1000) });
});

const RESOURCE = { id: 'RES-1', name: 'Cacheable resource', revision: 7 };
const ETAG = `"${crypto.createHash('sha1').update(JSON.stringify(RESOURCE)).digest('hex')}"`;

router.get('/etag', (req, res) => {
  res.set({ ETag: ETAG, 'Cache-Control': 'private, max-age=60' });
  if (req.get('if-none-match') === ETAG) {
    complete('headers-etag');
    return res.status(304).end();
  }
  return res.json(RESOURCE);
});

router.get('/negotiate', (req, res) => {
  const row = { id: 1, name: 'Asha', city: 'Bengaluru' };
  res.vary('Accept');
  const type = req.accepts(['application/json', 'application/xml', 'text/csv']);
  if (type === 'application/json') return res.json(row);
  if (type === 'application/xml') {
    return res.type('application/xml').send(`<row><id>1</id><name>Asha</name><city>Bengaluru</city></row>`);
  }
  if (type === 'text/csv') return res.type('text/csv').send('id,name,city\n1,Asha,Bengaluru\n');
  throw new ApiError(406, 'NOT_ACCEPTABLE', 'This resource is available as JSON, XML or CSV.', {
    supported: ['application/json', 'application/xml', 'text/csv'],
  });
});

const VERSIONS = {
  '2025-01': { deprecated: true, body: { fullName: 'Asha Rao', phone: '+919800000001' } },
  '2026-01': { deprecated: false, body: { name: { first: 'Asha', last: 'Rao' }, phones: ['+919800000001'] } },
};

router.get('/versioned', (req, res) => {
  const requested = req.get('api-version');
  if (!requested) {
    throw new ApiError(400, 'API_VERSION_REQUIRED', 'Send the API-Version header.', { supported: Object.keys(VERSIONS) });
  }
  const version = Object.prototype.hasOwnProperty.call(VERSIONS, requested) ? VERSIONS[requested] : null;
  if (!version) throw new ApiError(400, 'API_VERSION_UNKNOWN', `Unknown version ${requested}.`, { supported: Object.keys(VERSIONS) });
  res.set('API-Version', requested);
  if (version.deprecated) {
    complete('headers-deprecation');
    res.set({ Deprecation: 'true', Sunset: 'Wed, 30 Dec 2026 23:59:59 GMT', Link: '</api/headers/versioned>; rel="successor-version"' });
  }
  res.json(version.body);
});

router.get('/rate-info', authenticate, (req, res) => {
  res.set({
    'X-RateLimit-Limit': '100',
    'X-RateLimit-Remaining': '99',
    'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.json({ note: 'Assert on the response headers of this call.' });
});

// Practice helper. A real server would never sign for you.
router.post('/signature/sign', (req, res) => {
  const { payload } = req.body || {};
  if (typeof payload !== 'string') {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Send the exact text you will post as a string.', [
      { path: 'payload', message: 'must be a string' },
    ]);
  }
  const timestamp = Math.floor(Date.now() / 1000);
  res.json({ timestamp: String(timestamp), signature: sign(timestamp, payload), algorithm: 'HMAC-SHA256 of "<timestamp>.<raw body>"' });
});

router.post('/signature/verify', (req, res) => {
  const signature = req.get('x-signature');
  const timestamp = req.get('x-signature-timestamp');
  if (!signature || !timestamp) {
    throw new ApiError(401, 'SIGNATURE_MISSING', 'Send X-Signature and X-Signature-Timestamp.');
  }
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > FIVE_MINUTES) {
    throw new ApiError(401, 'SIGNATURE_EXPIRED', 'The timestamp is more than 5 minutes from the server clock (replay protection).');
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  if (!safeEqual(signature, sign(timestamp, raw))) {
    throw new ApiError(401, 'SIGNATURE_INVALID', 'The signature does not match the raw body. Whitespace counts.');
  }
  complete('headers-signature');
  res.json({ verified: true });
});

module.exports = router;
