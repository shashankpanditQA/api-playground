# API Playground

A practice API for testers, running on your own computer. It has 49 challenges that tick off automatically when your real requests trigger the right behaviour.

## Start it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

| Open | For |
| --- | --- |
| http://localhost:3000 | Practice console and challenges |
| http://localhost:3000/docs | Swagger docs with Try it out |
| http://localhost:3000/openapi.json | OpenAPI spec, for import into any tool |
| `postman/api-playground.postman_collection.json` | Postman collection with assertions |

To use another port: `PORT=4000 npm start`. On Windows PowerShell: `$env:PORT=4000; npm start`.

With Docker: `docker build -t api-playground . && docker run -p 3000:3000 api-playground`

## Put it online

1. Push this folder to a GitHub repository.
2. In [Render](https://render.com), choose **New**, then **Blueprint**, and pick the repository. `render.yaml` sets everything up.
3. Open the `onrender.com` address Render gives you. In Postman, set `baseUrl` to it.

`PUBLIC_MODE=true` turns on the limits for a public address: 600 requests a minute per client, 50 KB bodies, 50 mocks, stored data that clears itself at 2000 records, and mocks that can't run as web pages.

Everyone using the address shares the same data and challenge progress, and anyone can reset it. Treat it as a practice server only, and never send real card or personal details.

## Sign in

| Method | Value | Role |
| --- | --- | --- |
| API key | `X-API-Key: pk_test_playground` | tester |
| Login | `tester` / `tester123` | Create, change and pay |
| Login | `admin` / `admin123` | Everything, including delete |
| Login | `viewer` / `viewer123` | Read only |

`POST /api/auth/login` returns a JWT. Send it as `Authorization: Bearer <token>`. Add `ttlSeconds` to the login body to choose its lifetime.

These are practice credentials. Keep the server on your own machine: it binds to `127.0.0.1` by default.

## What you can practise

### Banking, end to end

Live at `/api/bank`. Register your own customer, and only you can see that customer's data. **Use made-up details only, never your real password, PAN or personal information.** Data is deleted whenever the server restarts.

| Step | Call | Notes |
| --- | --- | --- |
| 1 | `POST /auth/register` | Use a new email on every run |
| 2 | `POST /auth/login` | Returns `mfaToken` and `devOtp` |
| 3 | `POST /auth/otp/verify` | Returns `accessToken` (15 minutes) and `refreshToken` |
| 4 | `POST /kyc`, then poll `GET /kyc` | A PAN starting with `REJ` is rejected |
| 5 | `POST /accounts` | Blocked until KYC is `VERIFIED` |
| 6 | `POST /accounts/{id}/deposits` | Practice money. Needs `Idempotency-Key` |
| 7 | `POST /beneficiaries`, then `POST /beneficiaries/{id}/activate` | Needs the code returned as `devOtp` |
| 8 | `POST /transfers` | Needs `Idempotency-Key` |
| 9 | `GET /accounts/{id}/statement` | JSON, or CSV with `Accept: text/csv` |
| Clean up | `DELETE /me` | Removes the customer and their data |

Amounts are whole paise, so `100000` means 1,000 rupees.

| Rule | Behaviour |
| --- | --- |
| `INTERNAL`, `IMPS` | Settle at once. `IMPS` maximum is 5 lakh rupees |
| `NEFT`, `RTGS` | Return `PROCESSING`, then settle in about 2 seconds. `RTGS` minimum is 2 lakh rupees |
| Above 50,000 rupees | Returns `PENDING_OTP`. Approve with `POST /transfers/{id}/confirm` |
| Daily limit | 10 lakh rupees per account by default. Lower it with `PATCH /accounts/{id}/limits` |
| Outside account ending `0000` | Becomes `REVERSED`, and the money is refunded |
| At this bank | Use IFSC `PLAY0000001` |
| 5 wrong passwords | `423` for 60 seconds |
| Another customer's data | `404` |

### Double-payment protection

`POST /api/payments` needs an `Idempotency-Key` header. Amounts are whole paise, so `10000` means 100 rupees.

```json
{
  "amount": { "value": 10000, "currency": "INR" },
  "source": { "accountId": "ACC-1001", "token": "tok_success" },
  "destination": { "accountId": "ACC-9001" }
}
```

| Situation | Response |
| --- | --- |
| No key | `400 IDEMPOTENCY_KEY_REQUIRED` |
| Same key, same body, first call finished | Stored response, `Idempotent-Replayed: true`, no new charge |
| Same key, same body, first call still running | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After` |
| Same key, different body | `422 IDEMPOTENCY_KEY_REUSED`, no charge |
| Invalid body | `422 VALIDATION_FAILED`, key stays unused |

The source `token` chooses the scenario:

| Token | What happens |
| --- | --- |
| `tok_success` | Charge succeeds |
| `tok_declined` | `402`, stored and replayed |
| `tok_slow` | Takes 3 seconds, for double-click tests |
| `tok_timeout_after_charge` | Money moves, but you see `504`. Retrying must not charge again |
| `tok_server_error_once` | `500` before money moves. Retrying really charges |

Check the truth in `GET /api/accounts/ACC-1001/ledger`. `POST /api/payments/unsafe` has no protection and double-charges on purpose, so you can see the bug your tests should catch.

### Headers

| Endpoint | Practice |
| --- | --- |
| `POST /api/headers/validate` | Six rules, with every failure reported at once |
| `GET /api/headers/etag` | `ETag`, `If-None-Match`, `304` |
| `GET /api/headers/negotiate` | `Accept` for JSON, XML, CSV, or `406` |
| `GET /api/headers/versioned` | `API-Version`, `Deprecation`, `Sunset` |
| `POST /api/headers/signature/verify` | HMAC signature over the raw body |
| `ANY /api/headers/echo` | See exactly what your client sent |

To sign a request yourself, take the HMAC-SHA256 of `<timestamp>.<raw body>` with the secret `playground-signing-secret`, and send `X-Signature: sha256=<hex>`.

### Nested JSON

`/api/orders` has customers, addresses, geo points, items, discounts and shipments.

- Validation errors give exact paths, such as `items[0].unitPrice.value`.
- Filter on any path: `?customer.address.city=Bengaluru`.
- Also available: `sort=-totals.grandTotal`, `page`, `limit`, and `fields=customer.name,totals`.
- `PATCH` is an RFC 7386 merge patch, and `null` removes a field.
- `PUT` needs `If-Match`. An old version gets `412`, and a missing header gets `428`.
- Only certain status changes are allowed: `PLACED` to `PACKED` to `SHIPPED` to `DELIVERED`, otherwise `409`.

### API mocking

Create a mock, then call it under `/mock`:

```bash
curl -X POST localhost:3000/api/mocks -H 'Content-Type: application/json' -d '{
  "method": "GET",
  "path": "/users/:id",
  "match": { "query": { "tier": "gold" } },
  "response": {
    "status": 200,
    "headers": { "X-Source": "mock" },
    "body": { "id": "{{params.id}}", "tier": "{{query.tier}}", "at": "{{now}}" },
    "delayMs": 200
  }
}'

curl 'localhost:3000/mock/users/7?tier=gold'
```

- **Sequences:** send `responses: [...]` instead of `response`, for example 503, 503, 200. `afterLast` is `repeatLast` or `loop`.
- **Matching:** `match` takes `query`, `headers` and a partial nested `body`.
- **Templates:** `{{params.x}}`, `{{query.x}}`, `{{headers.x}}`, `{{body.a.b}}`, `{{uuid}}`, `{{now}}`, `{{timestamp}}`, `{{randomInt}}`.
- **Verification:** `GET /api/mocks/{id}/calls` shows what the mock received.
- **Choosing a mock:** highest `priority` wins, then the newest. A miss returns `404` with near-miss reasons.

### Failures and retries

| Endpoint | Behaviour |
| --- | --- |
| `/api/simulate/status/{code}` | Any status from 200 to 599 |
| `/api/simulate/delay/{ms}` | Slow response, up to 30 seconds |
| `/api/simulate/flaky/{name}?failTimes=2` | Fails N times, then succeeds |
| `/api/simulate/rate-limited` | 5 calls per 10 seconds, then `429` |
| `/api/simulate/malformed` | `200` with truncated JSON |
| `/api/simulate/empty` | `200` with no body |
| `/api/simulate/wrong-content-type` | JSON labelled as HTML |
| `/api/simulate/schema-drift` | The contract changes on every other call |
| `/api/simulate/large?items=50000` | Large response |
| `POST /api/jobs` | `202`, then poll until complete |

### Complex JSON

| Endpoint | Practice |
| --- | --- |
| `GET /api/complex/company` | Deep document with unicode, nulls, mixed arrays, dotted keys, and an ID too large for JavaScript |
| `GET /api/complex/generate?depth=4&breadth=3&seed=42` | Repeatable generated trees |
| `POST /api/complex/extract` | Read values with paths such as `a.b[*].c` |
| `POST /api/complex/diff` | Find changes between two documents, including type changes |
| `POST /api/complex/batch` | `207` partial success, with types chosen by a `type` field |

## Good to know

- All errors have one shape: `{ "error": { "code", "message", "details", "requestId" } }`. Assert on `code`.
- `POST /api/admin/reset` restores the starting data and keeps your progress. Call it before a test run. Add `?progress=true` to clear progress too.
- Data lives in memory, so restarting the server also resets it. Progress is saved in `.progress.json`.
- Variable settings: `PORT`, `HOST`, `IDEMPOTENCY_TTL_SECONDS`, `PAYMENT_PROCESSING_MS`, `PAYMENT_SLOW_MS`.

## Changing it

`npm test` runs the automated suite against a live server. Challenges live in `src/challenges.js`. After you edit them, run `npm run postman` to rebuild the collection.
