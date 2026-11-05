'use strict';

const secured = [{ ApiKey: [] }, { Bearer: [] }];
const error = { $ref: '#/components/schemas/Error' };

const param = (name, where, example, description, required = where === 'path') => ({
  name,
  in: where,
  required,
  description,
  schema: { type: 'string' },
  example,
});
const idemKey = param('Idempotency-Key', 'header', 'practice-key-0001', 'Unique per payment. Reuse it only when retrying that same payment.', true);

function op(tag, summary, { auth, params, body, responses = { 200: 'Success' }, description, bodyType = 'application/json' } = {}) {
  const operation = { tags: [tag], summary };
  if (description) operation.description = description;
  if (auth) operation.security = secured;
  if (params) operation.parameters = params;
  if (body !== undefined) {
    operation.requestBody = { required: true, content: { [bodyType]: { schema: { type: 'object' }, example: body } } };
  }
  operation.responses = Object.fromEntries(
    Object.entries(responses).map(([code, text]) => [
      code,
      { description: text, content: Number(code) >= 400 ? { 'application/json': { schema: error } } : undefined },
    ])
  );
  return operation;
}

const order = {
  customer: {
    name: 'Neha Kapoor',
    contact: { email: 'neha@example.test', phones: [{ type: 'mobile', number: '+919811112222' }] },
    address: { line1: '8 Park Street', city: 'Kolkata', pincode: '700016', geo: { lat: 22.5535, lng: 88.3516 } },
  },
  items: [{ sku: 'HEADSET-01', quantity: 2, unitPrice: { value: 899900, currency: 'INR' }, discounts: [{ code: 'FESTIVE15', percent: 15 }] }],
};
const payment = {
  amount: { value: 10000, currency: 'INR' },
  source: { accountId: 'ACC-1001', token: 'tok_success' },
  destination: { accountId: 'ACC-9001' },
  metadata: { orderId: 'ORD-1001' },
};
const orderId = param('id', 'path', 'ORD-1001', 'Order id');
const paymentErrors = {
  201: 'Charged, or a stored success replayed (see Idempotent-Replayed)',
  400: 'Idempotency-Key missing or invalid',
  402: 'Declined or insufficient funds (stored and replayed)',
  409: 'First request with this key is still running',
  422: 'Invalid body, or key reused with a different body',
  500: 'tok_server_error_once: first attempt failed, no money moved',
  504: 'tok_timeout_after_charge: money moved, client sees a timeout',
};

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'API Playground',
    version: '1.0.0',
    description:
      'A practice API for testers. Use X-API-Key: pk_test_playground, or sign in for a bearer token.\n\nAmounts are whole paise, so 10000 means 100 rupees. POST /api/admin/reset restores the starting data.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Auth' },
    { name: 'Headers' },
    { name: 'Orders', description: 'Deeply nested JSON' },
    { name: 'Payments', description: 'Idempotency and double-payment protection' },
    { name: 'Mocks', description: 'Create mocks, then call them under /mock' },
    { name: 'Simulate', description: 'Failures, delays and retries' },
    { name: 'Complex JSON' },
    { name: 'Admin' },
  ],
  components: {
    securitySchemes: {
      ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      Bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'requestId'],
            properties: {
              code: { type: 'string', example: 'VALIDATION_FAILED' },
              message: { type: 'string' },
              details: { nullable: true },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
  },
  paths: {
    '/health': { get: op('Admin', 'Health check') },
    '/api/admin/reset': {
      post: op('Admin', 'Restore starting data', { params: [param('progress', 'query', 'false', 'true also clears challenge progress', false)] }),
    },
    '/api/challenges': { get: op('Admin', 'List challenges and your progress') },

    '/api/auth/login': {
      post: op('Auth', 'Sign in', {
        description: 'Users: admin/admin123, tester/tester123, viewer/viewer123. ttlSeconds sets the token lifetime.',
        body: { username: 'tester', password: 'tester123', ttlSeconds: 3600 },
        responses: { 200: 'Token issued', 401: 'Wrong credentials', 422: 'Invalid body' },
      }),
    },
    '/api/auth/me': { get: op('Auth', 'Show the signed-in user', { auth: true, responses: { 200: 'Current user', 401: 'Missing, invalid or expired credentials' } }) },

    '/api/headers/echo': { post: op('Headers', 'Echo the request back', { body: { any: 'json' } }), get: op('Headers', 'Echo the request back') },
    '/api/headers/validate': {
      post: op('Headers', 'Check six header rules', {
        description: 'Reports every failed rule at once.',
        params: [
          param('Accept', 'header', 'application/json', 'Must include application/json', true),
          param('X-Request-Id', 'header', '6f1c2b1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f', 'A UUID', true),
          param('X-Client-Version', 'header', '1.4.2', 'Semantic version', true),
          param('X-Client-Platform', 'header', 'web', 'web, ios or android', true),
          param('X-Timestamp', 'header', '1798000000', 'Unix seconds, within 5 minutes of now', true),
        ],
        body: {},
        responses: { 200: 'All rules passed', 400: 'One or more rules failed' },
      }),
    },
    '/api/headers/etag': { get: op('Headers', 'Conditional GET', { params: [param('If-None-Match', 'header', undefined, 'ETag from an earlier response', false)], responses: { 200: 'Resource with ETag', 304: 'Not modified' } }) },
    '/api/headers/negotiate': { get: op('Headers', 'Content negotiation', { description: 'Set Accept to JSON, XML or CSV.', responses: { 200: 'Requested format', 406: 'Unsupported format' } }) },
    '/api/headers/versioned': { get: op('Headers', 'Version by header', { params: [param('API-Version', 'header', '2025-01', '2025-01 is deprecated, 2026-01 is current', true)], responses: { 200: 'Body for that version', 400: 'Missing or unknown version' } }) },
    '/api/headers/rate-info': { get: op('Headers', 'Response headers to assert', { auth: true }) },
    '/api/headers/signature/sign': { post: op('Headers', 'Practice helper: sign a payload', { body: { payload: '{"event":"payment.captured","amount":100}' } }) },
    '/api/headers/signature/verify': {
      post: op('Headers', 'Verify an HMAC signature', {
        description: 'X-Signature is sha256=<hex HMAC of "<timestamp>.<raw body>">, using the secret playground-signing-secret.',
        params: [param('X-Signature', 'header', 'sha256=...', 'The signature', true), param('X-Signature-Timestamp', 'header', '1798000000', 'Unix seconds', true)],
        body: { event: 'payment.captured', amount: 100 },
        responses: { 200: 'Verified', 401: 'Missing, expired or invalid signature' },
      }),
    },

    '/api/orders': {
      get: op('Orders', 'List, filter, sort and page', {
        auth: true,
        description: 'Any dotted path works as a filter, such as customer.address.city=Bengaluru. Returns X-Total-Count and Link.',
        params: [
          param('customer.address.city', 'query', 'Bengaluru', 'Nested filter', false),
          param('status', 'query', 'PLACED', 'Status filter', false),
          param('sort', 'query', '-totals.grandTotal', 'Field. A leading - means descending', false),
          param('minTotal', 'query', undefined, 'Lowest grand total in paise', false),
          param('maxTotal', 'query', undefined, 'Highest grand total in paise', false),
          param('page', 'query', '1', 'Page number', false),
          param('limit', 'query', '10', '1 to 100', false),
        ],
      }),
      post: op('Orders', 'Create an order', { auth: true, body: order, responses: { 201: 'Created, with Location and ETag', 401: 'Not signed in', 403: 'Viewer role', 422: 'Errors with exact JSON paths' } }),
    },
    '/api/orders/{id}': {
      get: op('Orders', 'Get an order', { auth: true, params: [orderId, param('fields', 'query', 'customer.name,totals', 'Return only these fields', false)], responses: { 200: 'The order', 304: 'Not modified', 404: 'Not found' } }),
      put: op('Orders', 'Replace an order', { auth: true, params: [orderId, param('If-Match', 'header', '"v1"', 'ETag you last read', true)], body: order, responses: { 200: 'Replaced', 409: 'Status change not allowed', 412: 'Out-of-date version', 422: 'Invalid', 428: 'If-Match missing' } }),
      patch: op('Orders', 'Merge patch (RFC 7386)', { auth: true, params: [orderId], bodyType: 'application/merge-patch+json', body: { customer: { address: { city: 'Mysuru' } } }, responses: { 200: 'Patched', 409: 'Status change not allowed', 412: 'Out-of-date version', 422: 'Invalid or read-only field' } }),
      delete: op('Orders', 'Delete an order (admin only)', { auth: true, params: [orderId], responses: { 204: 'Deleted', 403: 'Not an admin', 404: 'Not found' } }),
    },
    '/api/orders/{id}/items/{sku}': { get: op('Orders', 'Get one item in an order', { auth: true, params: [orderId, param('sku', 'path', 'KB-MECH-87', 'Item SKU')], responses: { 200: 'The item', 404: 'Not found' } }) },

    '/api/payments/test-tokens': { get: op('Payments', 'What each test token does') },
    '/api/payments': {
      get: op('Payments', 'List payments', { auth: true, params: [param('status', 'query', 'SUCCEEDED', 'SUCCEEDED or FAILED', false), param('accountId', 'query', 'ACC-1001', 'Source account', false)] }),
      post: op('Payments', 'Create a payment (protected)', { auth: true, params: [idemKey], body: payment, responses: paymentErrors }),
    },
    '/api/payments/unsafe': { post: op('Payments', 'Create a payment (no protection, double-charges on purpose)', { auth: true, body: payment, responses: { 201: 'Charged, every time' } }) },
    '/api/payments/{id}': { get: op('Payments', 'Get a payment', { auth: true, params: [param('id', 'path', 'PAY-00001', 'Payment id')], responses: { 200: 'The payment', 404: 'Not found' } }) },
    '/api/payments/{id}/refunds': { post: op('Payments', 'Refund a payment', { auth: true, params: [param('id', 'path', 'PAY-00001', 'Payment id'), idemKey], body: { amount: { value: 5000, currency: 'INR' }, reason: 'customer_request' }, responses: { 201: 'Refunded', 409: 'Payment cannot be refunded', 422: 'More than the amount left' } }) },
    '/api/accounts': { get: op('Payments', 'List accounts and balances', { auth: true }) },
    '/api/accounts/{id}': { get: op('Payments', 'Get an account', { auth: true, params: [param('id', 'path', 'ACC-1001', 'Account id')] }) },
    '/api/accounts/{id}/ledger': { get: op('Payments', 'Ledger: prove how many times money moved', { auth: true, params: [param('id', 'path', 'ACC-1001', 'Account id')] }) },
    '/api/idempotency-keys/{key}': { get: op('Payments', 'Inspect a stored key', { auth: true, params: [param('key', 'path', 'practice-key-0001', 'The key')], responses: { 200: 'Key state', 404: 'Not stored' } }) },

    '/api/mocks': {
      get: op('Mocks', 'List mocks'),
      post: op('Mocks', 'Create a mock', {
        description: 'Send response, or responses for a sequence. Optional: match (query, headers, body), priority, afterLast (repeatLast or loop), delayMs. Bodies support {{params.x}}, {{query.x}}, {{headers.x}}, {{body.a.b}}, {{uuid}}, {{now}}, {{timestamp}} and {{randomInt}}.',
        body: { method: 'GET', path: '/users/:id', match: { query: { tier: 'gold' } }, response: { status: 200, headers: { 'X-Source': 'mock' }, body: { id: '{{params.id}}', tier: '{{query.tier}}' }, delayMs: 0 } },
        responses: { 201: 'Created. Call it under /mock', 422: 'Invalid definition' },
      }),
      delete: op('Mocks', 'Delete all mocks', { responses: { 204: 'Deleted' } }),
    },
    '/api/mocks/{id}': {
      get: op('Mocks', 'Get a mock', { params: [param('id', 'path', 'mock_sample_user', 'Mock id')], responses: { 200: 'The mock', 404: 'Not found' } }),
      delete: op('Mocks', 'Delete a mock', { params: [param('id', 'path', 'mock_sample_user', 'Mock id')], responses: { 204: 'Deleted', 404: 'Not found' } }),
    },
    '/api/mocks/{id}/calls': { get: op('Mocks', 'Read what the mock received', { params: [param('id', 'path', 'mock_sample_user', 'Mock id')] }) },
    '/api/mocks/{id}/reset': { post: op('Mocks', 'Clear history and restart the sequence', { params: [param('id', 'path', 'mock_sample_user', 'Mock id')] }) },
    '/mock/sample/users/{id}': { get: op('Mocks', 'Built-in sample mock (any /mock path you create works too)', { params: [param('id', 'path', '42', 'Any value')] }) },

    '/api/simulate/status/{code}': { get: op('Simulate', 'Return any status', { params: [param('code', 'path', '503', '200 to 599')] }) },
    '/api/simulate/delay/{ms}': { get: op('Simulate', 'Respond after a delay', { params: [param('ms', 'path', '2000', '0 to 30000')] }) },
    '/api/simulate/flaky/{name}': { get: op('Simulate', 'Fail N times, then succeed', { params: [param('name', 'path', 'my-test', 'Counter name'), param('failTimes', 'query', '2', 'Failures before success', false)], responses: { 200: 'Success', 503: 'Failed, with Retry-After' } }) },
    '/api/simulate/rate-limited': { get: op('Simulate', 'Allow 5 calls per 10 seconds', { params: [param('X-Client-Id', 'header', 'my-client', 'Rate-limit bucket', false)], responses: { 200: 'Allowed', 429: 'Limited, with Retry-After' } }) },
    '/api/simulate/malformed': { get: op('Simulate', '200 with truncated JSON') },
    '/api/simulate/wrong-content-type': { get: op('Simulate', 'JSON labelled text/html') },
    '/api/simulate/empty': { get: op('Simulate', '200 with an empty body') },
    '/api/simulate/schema-drift': { get: op('Simulate', 'Contract changes on every other call') },
    '/api/simulate/large': { get: op('Simulate', 'Large response', { params: [param('items', 'query', '1000', '1 to 50000', false)] }) },
    '/api/jobs': { post: op('Simulate', 'Start a background job', { body: { durationMs: 3000, fail: false }, responses: { 202: 'Accepted, with Location', 422: 'Invalid' } }) },
    '/api/jobs/{id}': { get: op('Simulate', 'Poll a job', { params: [param('id', 'path', 'JOB-1', 'Job id')], responses: { 200: 'RUNNING, COMPLETED or FAILED', 404: 'Not found' } }) },

    '/api/complex/company': { get: op('Complex JSON', 'A deep document with awkward data', { description: 'Includes unicode, null, empty arrays, mixed types, keys with dots, and a number beyond JavaScript precision.' }) },
    '/api/complex/generate': { get: op('Complex JSON', 'Generate a repeatable tree', { params: [param('depth', 'query', '4', '0 to 12', false), param('breadth', 'query', '3', '0 to 10', false), param('seed', 'query', '42', 'Same seed, same output', false)], responses: { 200: 'The tree', 400: 'Invalid, or over 5000 nodes' } }) },
    '/api/complex/extract': { post: op('Complex JSON', 'Read a value by path', { body: { path: 'a.b[*].c', document: { a: { b: [{ c: 1 }, { c: 2 }] } } }, responses: { 200: 'The value and its type', 404: 'Nothing at that path', 422: 'Invalid' } }) },
    '/api/complex/diff': { post: op('Complex JSON', 'Compare two documents', { body: { left: { total: 100 }, right: { total: '100' } }, responses: { 200: 'Differences', 422: 'Invalid' } }) },
    '/api/complex/batch': { post: op('Complex JSON', 'Batch with partial success', { body: { items: [{ type: 'upi', vpa: 'asha@okbank' }, { type: 'crypto' }] }, responses: { 201: 'All succeeded', 207: 'Some succeeded', 422: 'All failed' } }) },
  },
};
