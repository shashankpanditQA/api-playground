'use strict';
/**
 * The single source for every practice challenge. The web console, the automated
 * tests and the Postman collection are all driven from this list.
 *
 * Variables in {{double braces}}: uuid (new every time), now (Unix seconds),
 * apiKey, idemKey (one per challenge run), plus anything a step captures.
 * {{params.x}}, {{query.x}} and {{body.x}} are left for the mock server to fill in.
 */
const key = { 'X-API-Key': '{{apiKey}}' };
const idem = { ...key, 'Idempotency-Key': '{{idemKey}}' };

const pay = (token = 'tok_success', value = 10000) => ({
  amount: { value, currency: 'INR' },
  source: { accountId: 'ACC-1001', token },
  destination: { accountId: 'ACC-9001' },
  metadata: { orderId: 'ORD-1001', attempt: { channel: 'web', retryOf: null } },
});

const validOrder = {
  customer: {
    name: 'Neha Kapoor',
    contact: { email: 'neha@example.test', phones: [{ type: 'mobile', number: '+919811112222' }] },
    address: { line1: '8 Park Street', city: 'Kolkata', pincode: '700016', geo: { lat: 22.5535, lng: 88.3516 } },
  },
  items: [
    {
      sku: 'HEADSET-01',
      name: 'Noise-cancelling headset',
      quantity: 2,
      unitPrice: { value: 899900, currency: 'INR' },
      options: { colour: 'black', warranty: { years: 2, onsite: false } },
      discounts: [{ code: 'FESTIVE15', percent: 15 }],
    },
  ],
};

const brokenOrder = {
  customer: {
    name: 'Neha Kapoor',
    contact: { email: 'not-an-email', phones: [{ number: '98111' }] },
    address: { city: 'Kolkata', pincode: '70', geo: { lat: 200, lng: 88.35 } },
  },
  items: [
    { sku: 'HEADSET-01', quantity: 0, unitPrice: { value: -5, currency: 'USD' }, discounts: [{ code: 'BAD', percent: 150 }] },
    { sku: 'HEADSET-01', quantity: 1, unitPrice: { value: 100, currency: 'INR' } },
  ],
};

const ledger = (name = 'Check the ledger') => ({ name, method: 'GET', path: '/api/accounts/ACC-1001/ledger', headers: key, expect: 200 });

const challenge = (id, track, level, title, task, hint, steps) => ({ id, track, level, title, task, hint, steps });
const AUTH = 'Sign-in and roles';
const HEADERS = 'Headers';
const NESTED = 'Nested JSON';
const IDEM = 'Double-payment protection';
const MOCK = 'API mocking';
const FAIL = 'Failures and retries';
const COMPLEX = 'Complex JSON';

module.exports = [
  challenge('auth-login', AUTH, 'Easy', 'Sign in and get a token',
    'Sign in as tester. Assert the response has accessToken, tokenType Bearer and a Cache-Control: no-store header.',
    'The token is a real JWT. Decode the middle part to read its role and expiry.',
    [{ name: 'Sign in', method: 'POST', path: '/api/auth/login', body: { username: 'tester', password: 'tester123' }, expect: 200, capture: { token: 'accessToken' } }]),
  challenge('auth-401', AUTH, 'Easy', 'Call a protected route with no credentials',
    'Call the orders list with no credentials. Assert 401 and the WWW-Authenticate header.',
    'Error codes are stable, so assert error.code rather than the message text.',
    [{ name: 'Send no credentials', method: 'GET', path: '/api/orders', expect: 401, expectHeaders: { 'www-authenticate': 'Bearer realm="api-playground"' } }]),
  challenge('auth-expired', AUTH, 'Medium', 'Use an expired token',
    'Get a token that lasts 1 second, wait for it to expire, then use it. Assert 401 and TOKEN_EXPIRED.',
    'ttlSeconds in the login body sets the token lifetime.',
    [
      { name: 'Get a 1-second token', method: 'POST', path: '/api/auth/login', body: { username: 'tester', password: 'tester123', ttlSeconds: 1 }, expect: 200, capture: { expiredToken: 'accessToken' } },
      { name: 'Use it after 2 seconds', method: 'GET', path: '/api/auth/me', headers: { Authorization: 'Bearer {{expiredToken}}' }, expect: 401, waitMs: 2100 },
    ]),
  challenge('auth-403', AUTH, 'Medium', 'Tell 401 and 403 apart',
    'Sign in as viewer, then try to delete an order. Assert 403 and that the response names the roles allowed.',
    '401 means the server does not know you. 403 means it does, and you are not allowed.',
    [
      { name: 'Sign in as viewer', method: 'POST', path: '/api/auth/login', body: { username: 'viewer', password: 'viewer123' }, expect: 200, capture: { viewerToken: 'accessToken' } },
      { name: 'Try to delete', method: 'DELETE', path: '/api/orders/ORD-1003', headers: { Authorization: 'Bearer {{viewerToken}}' }, expect: 403 },
    ]),

  challenge('headers-multi-fail', HEADERS, 'Easy', 'Break three header rules at once',
    'Post to the validator with at least 3 bad headers. Assert 400 and that error.details lists every broken rule.',
    'A good validator reports every problem at once, not only the first.',
    [{ name: 'Send bad headers', method: 'POST', path: '/api/headers/validate', headers: { 'Content-Type': 'text/plain', Accept: 'text/html', 'X-Client-Version': 'latest' }, bodyRaw: '{}', expect: 400 }]),
  challenge('headers-pass', HEADERS, 'Medium', 'Pass every header rule',
    'Send a request that passes all six rules: Content-Type, Accept, X-Request-Id, X-Client-Version, X-Client-Platform and X-Timestamp.',
    'X-Timestamp has to be within 5 minutes of now, so it must be generated on each run.',
    [{ name: 'Send valid headers', method: 'POST', path: '/api/headers/validate', headers: { Accept: 'application/json', 'X-Request-Id': '{{uuid}}', 'X-Client-Version': '1.4.2', 'X-Client-Platform': 'web', 'X-Timestamp': '{{now}}' }, body: {}, expect: 200 }]),
  challenge('headers-etag', HEADERS, 'Medium', 'Get a 304 with ETag',
    'Read the resource, take its ETag, and send it back in If-None-Match. Assert 304 and an empty body.',
    'A 304 tells the client its cached copy is still good.',
    [
      { name: 'Read and keep the ETag', method: 'GET', path: '/api/headers/etag', expect: 200, captureHeaders: { etag: 'etag' } },
      { name: 'Send If-None-Match', method: 'GET', path: '/api/headers/etag', headers: { 'If-None-Match': '{{etag}}' }, expect: 304 },
    ]),
  challenge('headers-signature', HEADERS, 'Hard', 'Send a correctly signed request',
    'Sign an exact body with HMAC-SHA256, then post the same bytes with X-Signature and X-Signature-Timestamp.',
    'Add one space to the body after signing and watch it fail. In your framework, compute the signature yourself with the secret playground-signing-secret.',
    [
      { name: 'Get a signature', method: 'POST', path: '/api/headers/signature/sign', body: { payload: '{"event":"payment.captured","amount":100}' }, expect: 200, capture: { signature: 'signature', sigTimestamp: 'timestamp' } },
      { name: 'Post the signed body', method: 'POST', path: '/api/headers/signature/verify', headers: { 'X-Signature': '{{signature}}', 'X-Signature-Timestamp': '{{sigTimestamp}}' }, bodyRaw: '{"event":"payment.captured","amount":100}', expect: 200 },
    ]),
  challenge('headers-deprecation', HEADERS, 'Easy', 'Spot a deprecated API version',
    'Call the versioned endpoint with API-Version: 2025-01. Assert the Deprecation and Sunset headers. Then compare the body shape with 2026-01.',
    'The two versions return different JSON for the same person. That is a breaking change.',
    [
      { name: 'Call the old version', method: 'GET', path: '/api/headers/versioned', headers: { 'API-Version': '2025-01' }, expect: 200, expectHeaders: { deprecation: 'true' } },
      { name: 'Call the new version', method: 'GET', path: '/api/headers/versioned', headers: { 'API-Version': '2026-01' }, expect: 200 },
    ]),

  challenge('nested-create', NESTED, 'Easy', 'Create a deeply nested order',
    'Create an order. Assert 201, the Location header, and that the server worked out totals.grandTotal correctly.',
    'Line total less 15%, plus 18% tax, in paise: 1799800 - 269970 = 1529830, plus 275369 tax = 1805199.',
    [{ name: 'Create the order', method: 'POST', path: '/api/orders', headers: key, body: validOrder, expect: 201 }]),
  challenge('nested-field-error', NESTED, 'Medium', 'Read errors from deep inside the JSON',
    'Post a broken order. Assert that error.details has exact paths such as items[0].unitPrice.value and customer.address.geo.lat.',
    'Every error reports its path, a message and the value received.',
    [{ name: 'Post the broken order', method: 'POST', path: '/api/orders', headers: key, body: brokenOrder, expect: 422 }]),
  challenge('nested-merge-patch', NESTED, 'Medium', 'Change one deep field with a merge patch',
    'Change only the city in ORD-1001. Assert the city changed, the pincode did not, and version went up.',
    'In a merge patch, null removes a field. Try customer.address.geo: null too.',
    [{ name: 'Patch the city', method: 'PATCH', path: '/api/orders/ORD-1001', headers: { ...key, 'Content-Type': 'application/merge-patch+json' }, body: { customer: { address: { city: 'Mysuru' } } }, expect: 200 }]),
  challenge('nested-lost-update', NESTED, 'Hard', 'Block a lost update',
    'Replace ORD-1002 using an out-of-date version in If-Match. Assert 412, and that the order did not change.',
    'Leave out If-Match on PUT and you get 428 instead.',
    [{ name: 'Send an old version', method: 'PUT', path: '/api/orders/ORD-1002', headers: { ...key, 'If-Match': '"v0"' }, body: validOrder, expect: 412 }]),
  challenge('nested-filter', NESTED, 'Easy', 'Filter on a nested field',
    'List orders by customer.address.city. Assert every result matches, and check X-Total-Count and the Link header.',
    'Also try sort=-totals.grandTotal, limit=1 and fields=customer.name,totals on a single order.',
    [{ name: 'Filter by city', method: 'GET', path: '/api/orders?customer.address.city=Bengaluru&sort=-totals.grandTotal&limit=1', headers: key, expect: 200 }]),

  challenge('idem-missing', IDEM, 'Easy', 'Send a payment with no key',
    'Post a payment with no Idempotency-Key. Assert 400, and that no money moved.',
    'Check the ACC-1001 balance before and after.',
    [{ name: 'Post without a key', method: 'POST', path: '/api/payments', headers: key, body: pay(), expect: 400 }]),
  challenge('idem-replay', IDEM, 'Medium', 'Pay twice, get charged once',
    'Send the same payment twice with the same key. Assert the same payment id both times, Idempotent-Replayed: true on the second, and one ledger debit.',
    'The server compares the JSON by content, so changing the order of keys still counts as the same request.',
    [
      { name: 'Pay', method: 'POST', path: '/api/payments', headers: idem, body: pay(), expect: 201 },
      { name: 'Pay again with the same key', method: 'POST', path: '/api/payments', headers: idem, body: pay(), expect: 201, expectHeaders: { 'idempotent-replayed': 'true' } },
      ledger('Confirm one debit'),
    ]),
  challenge('idem-conflict', IDEM, 'Medium', 'Reuse a key for a different payment',
    'Use one key for two different amounts. Assert 422 IDEMPOTENCY_KEY_REUSED, and that the second amount was not charged.',
    'This catches client bugs where a key is not regenerated for a new payment.',
    [
      { name: 'Pay 100 rupees', method: 'POST', path: '/api/payments', headers: idem, body: pay('tok_success', 10000), expect: 201 },
      { name: 'Same key, 200 rupees', method: 'POST', path: '/api/payments', headers: idem, body: pay('tok_success', 20000), expect: 422 },
    ]),
  challenge('idem-inflight', IDEM, 'Hard', 'Catch a double-click',
    'Fire two identical requests at the same moment with tok_slow. Assert one gets 201 and the other 409 with Retry-After, and only one charge happens.',
    'Use Send twice at once here. In your framework, use parallel threads or Promise.all.',
    [{ name: 'Send two at once', method: 'POST', path: '/api/payments', headers: idem, body: pay('tok_slow'), parallel: 2, expect: [201, 409] }]),
  challenge('idem-timeout', IDEM, 'Hard', 'Retry after a timeout',
    'The first call returns 504 although the money moved. Retry with the same key. Assert 201, with exactly one debit in the ledger.',
    'This is the real reason idempotency keys exist: the client cannot tell whether a timed-out charge went through.',
    [
      { name: 'Pay and get a timeout', method: 'POST', path: '/api/payments', headers: idem, body: pay('tok_timeout_after_charge'), expect: 504 },
      { name: 'Retry with the same key', method: 'POST', path: '/api/payments', headers: idem, body: pay('tok_timeout_after_charge'), expect: 201, expectHeaders: { 'idempotent-replayed': 'true' } },
      ledger('Confirm one debit'),
    ]),
  challenge('idem-server-error', IDEM, 'Medium', 'Retry after a failed attempt',
    'The first attempt fails with 500 before any money moves. Retry with the same key. Assert that this retry really charges, with no replay header set to true.',
    'A failure before the charge must not be stored, or the customer could never pay.',
    [
      { name: 'Pay and get a 500', method: 'POST', path: '/api/payments', headers: idem, body: pay('tok_server_error_once'), expect: 500 },
      { name: 'Retry with the same key', method: 'POST', path: '/api/payments', headers: idem, body: pay('tok_server_error_once'), expect: 201, expectHeaders: { 'idempotent-replayed': 'false' } },
    ]),
  challenge('idem-unsafe', IDEM, 'Easy', 'See a double charge happen',
    'Send the same payment twice to the unprotected endpoint. Assert two different payment ids and two debits. Write the test that would catch this bug.',
    'This endpoint is broken on purpose, so you can see the bug your tests should catch.',
    [
      { name: 'Pay', method: 'POST', path: '/api/payments/unsafe', headers: key, body: pay(), expect: 201 },
      { name: 'Pay again', method: 'POST', path: '/api/payments/unsafe', headers: key, body: pay(), expect: 201 },
      ledger('Find both debits'),
    ]),
  challenge('idem-overrefund', IDEM, 'Hard', 'Refund more than was paid',
    'Pay 100 rupees, then try to refund 200. Assert 422 REFUND_EXCEEDS_PAYMENT, and that the balance did not change.',
    'Then try two partial refunds that add up to more than the payment.',
    [
      { name: 'Pay 100 rupees', method: 'POST', path: '/api/payments', headers: idem, body: pay(), expect: 201, capture: { paymentId: 'id' } },
      { name: 'Refund 200 rupees', method: 'POST', path: '/api/payments/{{paymentId}}/refunds', headers: { ...key, 'Idempotency-Key': '{{uuid}}' }, body: { amount: { value: 20000, currency: 'INR' }, reason: 'customer_request' }, expect: 422 },
    ]),

  challenge('mock-create', MOCK, 'Easy', 'Create your first mock',
    'Create a mock, then call it under /mock. Assert the status, header and body you configured.',
    'Mocks take any status from 200 to 599. Add delayMs to simulate a slow service.',
    [
      { name: 'Create the mock', method: 'POST', path: '/api/mocks', body: { method: 'GET', path: '/practice/health', response: { status: 200, headers: { 'X-Service': 'inventory' }, body: { status: 'UP', dependencies: [{ name: 'db', up: true }] } } }, expect: 201 },
      { name: 'Call the mock', method: 'GET', path: '/mock/practice/health', expect: 200, expectHeaders: { 'x-service': 'inventory' } },
    ]),
  challenge('mock-template', MOCK, 'Medium', 'Return values from the request',
    'Create a mock whose response uses values from the request, then call it. Assert the id, query value and body value come back.',
    'Templates available: {{params.x}}, {{query.x}}, {{headers.x}}, {{body.a.b}}, and in your own mocks uuid, now, timestamp and randomInt.',
    [
      { name: 'Create the mock', method: 'POST', path: '/api/mocks', body: { method: 'POST', path: '/practice/users/:id', response: { status: 201, body: { id: '{{params.id}}', lang: '{{query.lang}}', city: '{{body.address.city}}' } } }, expect: 201 },
      { name: 'Call the mock', method: 'POST', path: '/mock/practice/users/77?lang=hi', body: { address: { city: 'Pune' } }, expect: 201 },
    ]),
  challenge('mock-sequence', MOCK, 'Medium', 'Fail twice, then recover',
    'Create a mock that returns 503, 503 and then 200. Call it three times. Use this to test retry logic in your client.',
    'Set afterLast to loop to cycle forever. The default repeats the last response.',
    [
      { name: 'Create the mock', method: 'POST', path: '/api/mocks', body: { method: 'GET', path: '/practice/retry', responses: [{ status: 503, body: { error: 'down' } }, { status: 503, body: { error: 'still down' } }, { status: 200, body: { ok: true } }] }, expect: 201 },
      { name: 'First call', method: 'GET', path: '/mock/practice/retry', expect: 503 },
      { name: 'Second call', method: 'GET', path: '/mock/practice/retry', expect: 503 },
      { name: 'Third call', method: 'GET', path: '/mock/practice/retry', expect: 200 },
    ]),
  challenge('mock-conditional', MOCK, 'Medium', 'Match only certain requests',
    'Create a mock that matches only when X-Tenant is gold. Assert 404 with near-miss details without it, and 200 with it.',
    'match also accepts query and body. A body match can be partial and deeply nested.',
    [
      { name: 'Create the mock', method: 'POST', path: '/api/mocks', body: { method: 'GET', path: '/practice/plan', match: { headers: { 'X-Tenant': 'gold' } }, response: { status: 200, body: { plan: 'gold', limits: { rps: 500 } } } }, expect: 201 },
      { name: 'Call without the header', method: 'GET', path: '/mock/practice/plan', expect: 404 },
      { name: 'Call with the header', method: 'GET', path: '/mock/practice/plan', headers: { 'X-Tenant': 'gold' }, expect: 200 },
    ]),
  challenge('mock-verify', MOCK, 'Medium', 'Verify what the mock received',
    'Call a mock, then read its call history. Assert the body and headers it received. This is how you prove your service called its dependency correctly.',
    'POST /api/mocks/{id}/reset clears the history between tests.',
    [
      { name: 'Create the mock', method: 'POST', path: '/api/mocks', body: { method: 'POST', path: '/practice/notify', response: { status: 202 } }, expect: 201, capture: { mockId: 'id' } },
      { name: 'Call the mock', method: 'POST', path: '/mock/practice/notify', headers: { 'X-Trace': 'abc-123' }, body: { to: 'asha@example.test', template: { id: 'receipt', vars: { amount: 100 } } }, expect: 202 },
      { name: 'Read the call history', method: 'GET', path: '/api/mocks/{{mockId}}/calls', expect: 200 },
    ]),

  challenge('sim-retry', FAIL, 'Medium', 'Retry until it works',
    'This endpoint fails twice with 503 and Retry-After, then succeeds. Write a retry with backoff that passes on the third attempt.',
    'Use a new name in the URL for a fresh counter. X-Attempt shows the attempt number.',
    [
      { name: 'First attempt', method: 'GET', path: '/api/simulate/flaky/{{idemKey}}?failTimes=2', expect: 503 },
      { name: 'Second attempt', method: 'GET', path: '/api/simulate/flaky/{{idemKey}}?failTimes=2', expect: 503 },
      { name: 'Third attempt', method: 'GET', path: '/api/simulate/flaky/{{idemKey}}?failTimes=2', expect: 200 },
    ]),
  challenge('sim-rate-limit', FAIL, 'Easy', 'Hit the rate limit',
    'Call the endpoint 6 times within 10 seconds. Assert X-RateLimit-Remaining counts down and the 6th call gets 429 with Retry-After.',
    'X-Client-Id picks your rate-limit bucket, so a new value starts a new count.',
    [{ name: 'Call 6 times', method: 'GET', path: '/api/simulate/rate-limited', headers: { 'X-Client-Id': '{{idemKey}}' }, repeat: 6, expect: 429 }]),
  challenge('sim-malformed', FAIL, 'Easy', 'Handle broken JSON',
    'This returns 200 with truncated JSON. Check that your test framework reports a clear failure rather than crashing.',
    'Also try /api/simulate/empty and /api/simulate/wrong-content-type.',
    [{ name: 'Get broken JSON', method: 'GET', path: '/api/simulate/malformed', expect: 200 }]),
  challenge('sim-schema-drift', FAIL, 'Medium', 'Catch a changed contract',
    'Call it twice. The second response changes types and renames a field while still returning 200. Write a schema check that fails on it.',
    'Status-only tests pass here. That is the point.',
    [
      { name: 'First call', method: 'GET', path: '/api/simulate/schema-drift', expect: 200 },
      { name: 'Second call', method: 'GET', path: '/api/simulate/schema-drift', expect: 200 },
    ]),
  challenge('sim-job', FAIL, 'Medium', 'Poll a background job',
    'Start a job, assert 202 and Location, then poll until status is COMPLETED.',
    'Poll with a timeout. Send fail: true to test the failure path as well.',
    [
      { name: 'Start the job', method: 'POST', path: '/api/jobs', body: { durationMs: 1000 }, expect: 202, capture: { jobId: 'id' } },
      { name: 'Poll after it finishes', method: 'GET', path: '/api/jobs/{{jobId}}', expect: 200, waitMs: 1200 },
    ]),

  challenge('complex-generate', COMPLEX, 'Easy', 'Get repeatable generated JSON',
    'Generate a tree twice with one seed. Assert both responses are identical, then change the seed and assert they differ.',
    'depth, breadth and seed let you test how your parser copes with size and depth.',
    [
      { name: 'Generate', method: 'GET', path: '/api/complex/generate?depth=4&breadth=3&seed=42', expect: 200 },
      { name: 'Generate again', method: 'GET', path: '/api/complex/generate?depth=4&breadth=3&seed=42', expect: 200 },
    ]),
  challenge('complex-extract', COMPLEX, 'Medium', 'Pull values out with wildcards',
    'Read every skill name across all members. Then write the same path in your own tool, using /api/complex/company as the document.',
    'That document has unicode, null, empty arrays, mixed arrays, keys with dots and a number too large for JavaScript.',
    [{ name: 'Extract the names', method: 'POST', path: '/api/complex/extract', body: { path: 'members[*].skills[*].name', document: { members: [{ name: 'Arjun', skills: [{ name: 'Java' }, { name: 'Kafka' }] }, { name: 'Sara', skills: [] }, { name: 'Meera', skills: [{ name: 'SQL' }] }] } }, expect: 200 }]),
  challenge('complex-diff', COMPLEX, 'Medium', 'Compare two responses',
    'Compare two documents where one value changes type. Assert a typeChanged entry at the exact path.',
    '"100" and 100 look alike in a log, but they are different types.',
    [{ name: 'Compare the documents', method: 'POST', path: '/api/complex/diff', body: { left: { order: { total: 100, items: [{ sku: 'A' }] } }, right: { order: { total: '100', items: [{ sku: 'A' }, { sku: 'B' }] } } }, expect: 200 }]),
  challenge('complex-batch', COMPLEX, 'Hard', 'Assert a partial success',
    'Send a batch where some items are valid. Assert 207, the summary counts and the result for each item, chosen by the type field.',
    'Each item has its own status, so a test that only checks the top-level status will miss failures.',
    [{ name: 'Send a mixed batch', method: 'POST', path: '/api/complex/batch', body: { items: [{ type: 'card', last4: '4242', expiry: { month: 12, year: 2028 } }, { type: 'upi', vpa: 'not-valid' }, { type: 'netbanking', bankCode: 'HDFC' }, { type: 'crypto' }] }, expect: 207 }]),
];
