'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { ApiError, signJwt, verifyJwt, canonical, sha256, sleep, clone, isObject, mergePatch } = require('../lib');
const { state, complete } = require('../store');

const router = express.Router();
const scrypt = promisify(crypto.scrypt);

const ACCESS_TTL = 900;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_ATTEMPTS = 3;
const LOCK_AFTER = 5;
const LOCK_MS = Number(process.env.BANK_LOCK_SECONDS || 60) * 1000;
const KYC_MS = Number(process.env.BANK_KYC_MS || 1000);
const SETTLE_MS = Number(process.env.BANK_SETTLE_MS || 1500);
const PROCESSING_MS = Number(process.env.BANK_PROCESSING_MS || 150);

const BANK_IFSC = 'PLAY0000001';
const MAX_DEPOSIT = 100000000; // 10 lakh rupees, in paise
const OTP_THRESHOLD = 5000000; // 50,000 rupees
const DEFAULT_DAILY_LIMIT = 100000000; // 10 lakh rupees
const MODE_RULES = {
  INTERNAL: {},
  IMPS: { max: 50000000 }, // 5 lakh rupees
  NEFT: {},
  RTGS: { min: 20000000 }, // 2 lakh rupees
};
const IDEM_KEY = /^[\w:.-]{8,128}$/;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bank = () => state.bank;
const nextId = (prefix, name) => {
  bank().seq[name] = (bank().seq[name] || 0) + 1;
  return `${prefix}-${String(bank().seq[name]).padStart(6, '0')}`;
};
const invalid = (errors) => new ApiError(422, 'VALIDATION_FAILED', `The request has ${errors.length} invalid field(s).`, errors);
const newOtp = () => String(crypto.randomInt(100000, 1000000));
const OTP_NOTE = 'Practice only: a real bank sends this code by SMS and never returns it in the API response.';

function collector() {
  const errors = [];
  return {
    errors,
    fail: (path, message, received) => errors.push({ path, message, received: received === undefined ? null : received }),
  };
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 32);
  return { salt, hash: derived.toString('hex') };
}

function checkOtp(record, otp) {
  if (Date.now() > record.expiresAt) throw new ApiError(401, 'OTP_EXPIRED', 'This code has expired. Start again.');
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) throw invalid([{ path: 'otp', message: 'must be a 6-digit string', received: otp ?? null }]);
  if (otp === record.code) return true;
  record.attempts += 1;
  return false;
}

/* Customers */
function publicCustomer(c) {
  return {
    id: c.id,
    fullName: c.fullName,
    email: c.email,
    phone: c.phone,
    dateOfBirth: c.dateOfBirth,
    address: c.address,
    kycStatus: kycOf(c).status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function kycOf(c) {
  const { kyc } = c;
  if (kyc.status === 'PENDING' && Date.now() >= kyc.decideAt) {
    kyc.status = kyc.willReject ? 'REJECTED' : 'VERIFIED';
    kyc.decidedAt = new Date().toISOString();
    if (kyc.willReject) kyc.reason = 'The PAN could not be verified.';
  }
  return kyc;
}

function validateProfile(body, { fail }, partial = false) {
  const need = (key) => !partial || key in body;
  if (need('fullName') && (typeof body.fullName !== 'string' || body.fullName.trim().length < 2 || body.fullName.length > 100)) fail('fullName', 'must be 2 to 100 characters', body.fullName);
  if (need('phone') && !/^\+\d{10,15}$/.test(body.phone ?? '')) fail('phone', 'must look like +919800000000', body.phone);
  if (need('dateOfBirth')) {
    const born = new Date(body.dateOfBirth);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dateOfBirth ?? '') || Number.isNaN(born.getTime())) fail('dateOfBirth', 'must be YYYY-MM-DD', body.dateOfBirth);
    else {
      const adult = new Date(born);
      adult.setFullYear(born.getFullYear() + 18);
      if (adult > new Date()) fail('dateOfBirth', 'customer must be at least 18', body.dateOfBirth);
    }
  }
  if (need('address')) {
    const { address } = body;
    if (!isObject(address)) fail('address', 'must be an object', address);
    else {
      if (typeof address.line1 !== 'string' || !address.line1.trim()) fail('address.line1', 'is required', address.line1);
      if (typeof address.city !== 'string' || !address.city.trim()) fail('address.city', 'is required', address.city);
      if (typeof address.state !== 'string' || !address.state.trim()) fail('address.state', 'is required', address.state);
      if (!/^\d{6}$/.test(address.pincode ?? '')) fail('address.pincode', 'must be 6 digits', address.pincode);
    }
  }
}

router.post('/auth/register', wrap(async (req, res) => {
  const body = isObject(req.body) ? req.body : {};
  const check = collector();
  validateProfile(body, check);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email ?? '')) check.fail('email', 'must be a valid email address', body.email);
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 72 || !/[A-Za-z]/.test(body.password) || !/\d/.test(body.password)) {
    check.fail('password', 'must be 8 to 72 characters, with a letter and a number');
  }
  if (check.errors.length) throw invalid(check.errors);
  const email = body.email.toLowerCase();
  if (bank().emails.has(email)) throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'A customer with this email already exists.');
  bank().emails.set(email, null); // Reserve it across the await below.
  let secret;
  try {
    secret = await hashPassword(body.password);
  } catch (err) {
    bank().emails.delete(email);
    throw err;
  }
  const now = new Date().toISOString();
  const customer = {
    id: nextId('CUS', 'customer'),
    fullName: body.fullName,
    email,
    phone: body.phone,
    dateOfBirth: body.dateOfBirth,
    address: clone(body.address),
    secret,
    kyc: { status: 'NOT_SUBMITTED' },
    failedLogins: 0,
    lockedUntil: 0,
    createdAt: now,
    updatedAt: now,
  };
  bank().customers.set(customer.id, customer);
  bank().emails.set(email, customer.id);
  res.status(201).set('Location', '/api/bank/me').json(publicCustomer(customer));
}));

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = isObject(req.body) ? req.body : {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw invalid([{ path: 'email', message: 'email and password are required', received: null }]);
  }
  const wrong = new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  const id = bank().emails.get(email.toLowerCase());
  const customer = id && bank().customers.get(id);
  if (!customer) {
    await hashPassword(password); // Same work as a real check, so timing doesn't reveal who is registered.
    throw wrong;
  }
  if (customer.lockedUntil > Date.now()) {
    throw new ApiError(423, 'ACCOUNT_LOCKED', 'Too many failed sign-ins. Try again later.', undefined, {
      'Retry-After': String(Math.ceil((customer.lockedUntil - Date.now()) / 1000)),
    });
  }
  const { hash } = await hashPassword(password, customer.secret.salt);
  if (hash !== customer.secret.hash) {
    customer.failedLogins += 1;
    if (customer.failedLogins >= LOCK_AFTER) {
      customer.failedLogins = 0;
      customer.lockedUntil = Date.now() + LOCK_MS;
      complete('bank-lockout');
      throw new ApiError(423, 'ACCOUNT_LOCKED', 'Too many failed sign-ins. Try again later.', undefined, { 'Retry-After': String(Math.ceil(LOCK_MS / 1000)) });
    }
    throw wrong;
  }
  customer.failedLogins = 0;
  const mfaToken = crypto.randomUUID();
  const code = newOtp();
  bank().mfa.set(mfaToken, { customerId: customer.id, code, attempts: 0, expiresAt: Date.now() + OTP_TTL_MS });
  res.json({ mfaRequired: true, mfaToken, devOtp: code, expiresIn: OTP_TTL_MS / 1000, note: OTP_NOTE });
}));

function issueTokens(customer, family = crypto.randomUUID()) {
  const now = Math.floor(Date.now() / 1000);
  const refreshToken = crypto.randomBytes(32).toString('hex');
  bank().refresh.set(sha256(refreshToken), { customerId: customer.id, family, used: false });
  return {
    accessToken: signJwt({ sub: customer.id, aud: 'bank', jti: crypto.randomUUID(), family, iat: now, exp: now + ACCESS_TTL }),
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TTL,
  };
}

router.post('/auth/otp/verify', (req, res) => {
  const { mfaToken, otp } = isObject(req.body) ? req.body : {};
  const record = typeof mfaToken === 'string' ? bank().mfa.get(mfaToken) : null;
  if (!record) throw new ApiError(401, 'MFA_TOKEN_INVALID', 'This sign-in attempt is not valid. Sign in again.');
  if (!checkOtp(record, otp)) {
    const left = OTP_ATTEMPTS - record.attempts;
    if (left <= 0) bank().mfa.delete(mfaToken);
    throw new ApiError(401, 'OTP_INVALID', left > 0 ? 'The code is incorrect.' : 'Too many wrong codes. Sign in again.', { attemptsLeft: Math.max(left, 0) });
  }
  bank().mfa.delete(mfaToken);
  const customer = bank().customers.get(record.customerId);
  if (!customer) throw new ApiError(401, 'MFA_TOKEN_INVALID', 'This sign-in attempt is not valid. Sign in again.');
  res.set('Cache-Control', 'no-store').json(issueTokens(customer));
});

router.post('/auth/refresh', (req, res) => {
  const token = req.body?.refreshToken;
  const key = typeof token === 'string' ? sha256(token) : '';
  const record = bank().refresh.get(key);
  if (!record) throw new ApiError(401, 'REFRESH_TOKEN_INVALID', 'This refresh token is not valid.');
  if (record.used) {
    // A used token coming back suggests it was stolen, so end that whole sign-in.
    bank().revokedFamilies.add(record.family);
    complete('bank-refresh-reuse');
    throw new ApiError(401, 'REFRESH_TOKEN_REUSED', 'This refresh token was already used, so this sign-in has been ended.');
  }
  if (bank().revokedFamilies.has(record.family)) throw new ApiError(401, 'REFRESH_TOKEN_INVALID', 'This refresh token is not valid.');
  const customer = bank().customers.get(record.customerId);
  if (!customer) throw new ApiError(401, 'REFRESH_TOKEN_INVALID', 'This refresh token is not valid.');
  record.used = true;
  res.set('Cache-Control', 'no-store').json(issueTokens(customer, record.family));
});

function requireCustomer(req, res, next) {
  const challenge = { 'WWW-Authenticate': 'Bearer realm="api-playground-bank"' };
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) return next(new ApiError(401, 'AUTH_REQUIRED', 'Send Authorization: Bearer <accessToken>.', undefined, challenge));
  const { payload, error } = verifyJwt(match[1]);
  if (error) return next(new ApiError(401, error, 'The bearer token was rejected.', undefined, challenge));
  if (payload.aud !== 'bank' || bank().revokedFamilies.has(payload.family)) {
    return next(new ApiError(401, 'TOKEN_INVALID', 'The bearer token was rejected.', undefined, challenge));
  }
  req.customer = bank().customers.get(payload.sub);
  req.tokenFamily = payload.family;
  if (!req.customer) return next(new ApiError(401, 'TOKEN_INVALID', 'The bearer token was rejected.', undefined, challenge));
  return next();
}

router.use(requireCustomer);

router.post('/auth/logout', (req, res) => {
  bank().revokedFamilies.add(req.tokenFamily);
  res.status(204).end();
});

router.get('/me', (req, res) => res.json(publicCustomer(req.customer)));

router.patch('/me', (req, res) => {
  if (!isObject(req.body)) throw invalid([{ path: '$', message: 'must be a JSON object', received: req.body }]);
  const blocked = ['id', 'email', 'kycStatus', 'createdAt', 'updatedAt', 'password', 'secret', 'kyc'].filter((k) => k in req.body);
  if (blocked.length) throw new ApiError(422, 'READ_ONLY_FIELD', 'These fields cannot be changed here.', blocked.map((path) => ({ path, message: 'is read-only' })));
  const unknown = Object.keys(req.body).filter((k) => !['fullName', 'phone', 'dateOfBirth', 'address'].includes(k));
  if (unknown.length) throw invalid(unknown.map((path) => ({ path, message: 'is not a known field' })));
  const merged = mergePatch({ fullName: req.customer.fullName, phone: req.customer.phone, dateOfBirth: req.customer.dateOfBirth, address: req.customer.address }, req.body);
  const check = collector();
  validateProfile(merged, check);
  if (check.errors.length) throw invalid(check.errors);
  Object.assign(req.customer, merged, { updatedAt: new Date().toISOString() });
  res.json(publicCustomer(req.customer));
});

// Test clean-up: removes this customer and everything they own.
router.delete('/me', (req, res) => {
  const { id, email } = req.customer;
  for (const account of [...bank().accounts.values()]) {
    if (account.customerId === id) {
      bank().accounts.delete(account.id);
      bank().accountNumbers.delete(account.accountNumber);
    }
  }
  for (const b of [...bank().beneficiaries.values()]) if (b.customerId === id) bank().beneficiaries.delete(b.id);
  bank().customers.delete(id);
  bank().emails.delete(email);
  bank().revokedFamilies.add(req.tokenFamily);
  res.status(204).end();
});

/* KYC */
const publicKyc = (c) => {
  const { status, submittedAt, decidedAt, reason, panMasked } = kycOf(c);
  return { status, panMasked, submittedAt, decidedAt, reason };
};

router.post('/kyc', (req, res) => {
  const current = kycOf(req.customer).status;
  if (current === 'PENDING' || current === 'VERIFIED') throw new ApiError(409, 'KYC_ALREADY_SUBMITTED', `KYC is already ${current}.`);
  const docs = req.body?.documents;
  const check = collector();
  let pan;
  if (!Array.isArray(docs) || !docs.length) check.fail('documents', 'must be a non-empty array', docs);
  else {
    docs.forEach((doc, i) => {
      if (doc?.type !== 'PAN') check.fail(`documents[${i}].type`, 'must be PAN', doc?.type);
      else if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(doc.number ?? '')) check.fail(`documents[${i}].number`, 'must look like ABCDE1234F', doc.number);
      else pan = doc.number;
    });
    if (!check.errors.length && !pan) check.fail('documents', 'must include a PAN');
  }
  if (check.errors.length) throw invalid(check.errors);
  req.customer.kyc = {
    status: 'PENDING',
    panMasked: `${pan.slice(0, 2)}XXXXXX${pan.slice(-2)}`, // Only the masked form is kept.
    willReject: pan.startsWith('REJ'),
    submittedAt: new Date().toISOString(),
    decideAt: Date.now() + KYC_MS,
  };
  res.status(202).set({ Location: '/api/bank/kyc', 'Retry-After': '1' }).json(publicKyc(req.customer));
});

router.get('/kyc', (req, res) => {
  const kyc = publicKyc(req.customer);
  if (kyc.status === 'REJECTED') complete('bank-kyc-rejected');
  if (kyc.status === 'PENDING') res.set('Retry-After', '1');
  res.json(kyc);
});

/* Accounts */
function ownedAccount(req, id) {
  const account = bank().accounts.get(id);
  if (account && account.customerId !== req.customer.id) complete('bank-bola');
  if (!account || account.customerId !== req.customer.id) {
    // The same answer whether it exists or not, so ids can't be probed.
    throw new ApiError(404, 'ACCOUNT_NOT_FOUND', `No account with id ${id}.`);
  }
  return account;
}

router.post('/accounts', (req, res) => {
  if (kycOf(req.customer).status !== 'VERIFIED') {
    complete('bank-kyc-gate');
    throw new ApiError(403, 'KYC_REQUIRED', 'Complete KYC before opening an account.', { kycStatus: req.customer.kyc.status });
  }
  const type = req.body?.type;
  if (!['SAVINGS', 'CURRENT'].includes(type)) throw invalid([{ path: 'type', message: 'must be SAVINGS or CURRENT', received: type ?? null }]);
  bank().seq.accountNumber = (bank().seq.accountNumber || 0) + 1;
  const account = {
    id: nextId('ACT', 'account'),
    customerId: req.customer.id,
    accountNumber: `50100${String(bank().seq.accountNumber).padStart(9, '0')}`,
    ifsc: BANK_IFSC,
    type,
    status: 'ACTIVE',
    currency: 'INR',
    balance: 0,
    limits: { dailyTransferLimit: DEFAULT_DAILY_LIMIT },
    openedAt: new Date().toISOString(),
  };
  bank().accounts.set(account.id, account);
  bank().accountNumbers.set(account.accountNumber, account.id);
  res.status(201).set('Location', `/api/bank/accounts/${account.id}`).json(account);
});

router.get('/accounts', (req, res) => {
  const data = [...bank().accounts.values()].filter((a) => a.customerId === req.customer.id);
  res.json({ data, meta: { total: data.length } });
});

router.get('/accounts/:id', (req, res) => res.json(ownedAccount(req, req.params.id)));

router.get('/accounts/:id/balance', (req, res) => {
  const a = ownedAccount(req, req.params.id);
  res.json({ accountId: a.id, currency: a.currency, available: a.balance, asOf: new Date().toISOString() });
});

router.patch('/accounts/:id/limits', (req, res) => {
  const account = ownedAccount(req, req.params.id);
  const value = req.body?.dailyTransferLimit;
  if (!Number.isInteger(value) || value < 100 || value > DEFAULT_DAILY_LIMIT) {
    throw invalid([{ path: 'dailyTransferLimit', message: `must be a whole number of paise from 100 to ${DEFAULT_DAILY_LIMIT}`, received: value ?? null }]);
  }
  account.limits.dailyTransferLimit = value;
  res.json(account);
});

function setStatus(req, res, from, to) {
  const account = ownedAccount(req, req.params.id);
  if (account.status !== from) throw new ApiError(409, 'INVALID_ACCOUNT_STATE', `This account is ${account.status}, so it can't become ${to}.`);
  account.status = to;
  res.json(account);
}

router.post('/accounts/:id/freeze', (req, res) => setStatus(req, res, 'ACTIVE', 'FROZEN'));
router.post('/accounts/:id/unfreeze', (req, res) => setStatus(req, res, 'FROZEN', 'ACTIVE'));
router.post('/accounts/:id/close', (req, res) => {
  const account = ownedAccount(req, req.params.id);
  if (account.balance !== 0) throw new ApiError(409, 'BALANCE_NOT_ZERO', 'Move the balance out before closing this account.', { balance: account.balance });
  setStatus(req, res, 'ACTIVE', 'CLOSED');
});

/* Money */
function post(account, type, category, amount, narration, reference) {
  account.balance += type === 'CREDIT' ? amount : -amount;
  const entry = {
    id: nextId('TXN', 'transaction'),
    accountId: account.id,
    type,
    category,
    amount: { value: amount, currency: 'INR' },
    balanceAfter: account.balance,
    narration,
    reference,
    at: new Date().toISOString(),
  };
  bank().transactions.push(entry);
  return entry;
}

/** Idempotency-Key protocol. Business failures are stored and replayed; validation failures are not. */
function idempotent(validate, execute) {
  return wrap(async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header with this request.');
    if (!IDEM_KEY.test(key)) throw new ApiError(400, 'IDEMPOTENCY_KEY_INVALID', 'The key must be 8 to 128 characters: letters, numbers, _ - : or .');
    validate(req);
    const scoped = `${req.customer.id}:${key}`;
    const fingerprint = sha256(`${req.baseUrl}${req.path} ${canonical(req.body)}`);
    const record = bank().idempotency.get(scoped);
    res.set('Idempotency-Key', key);
    if (record) {
      if (record.fingerprint !== fingerprint) throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This key was already used with a different request.');
      if (record.status === undefined) throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The first request with this key is still running.', undefined, { 'Retry-After': '1' });
      if (req.body?.fromAccountId) complete('bank-transfer-replay');
      res.set({ 'Idempotent-Replayed': 'true', 'X-Original-Request-Id': record.requestId, ...record.headers });
      return res.status(record.status).json(record.body);
    }
    const entry = { fingerprint, requestId: req.id };
    bank().idempotency.set(scoped, entry);
    res.set('Idempotent-Replayed', 'false');
    await sleep(PROCESSING_MS);
    let result;
    try {
      result = execute(req);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        bank().idempotency.delete(scoped);
        throw err;
      }
      result = { status: err.status, body: { error: { code: err.code, message: err.message, details: err.details ?? null, requestId: req.id } } };
    }
    Object.assign(entry, { status: result.status, body: clone(result.body), headers: result.headers || {} });
    res.set(entry.headers);
    return res.status(result.status).json(result.body);
  });
}

function checkAmount(amount, check, path = 'amount') {
  if (!isObject(amount)) return check.fail(path, 'must be an object', amount);
  if (!Number.isSafeInteger(amount.value) || amount.value < 1) check.fail(`${path}.value`, 'must be a positive whole number of paise', amount.value);
  if (amount.currency !== 'INR') check.fail(`${path}.currency`, 'must be INR', amount.currency);
  return undefined;
}

router.post('/accounts/:id/deposits', idempotent(
  (req) => {
    ownedAccount(req, req.params.id);
    const check = collector();
    checkAmount(req.body?.amount, check);
    if (!check.errors.length && req.body.amount.value > MAX_DEPOSIT) check.fail('amount.value', `must be at most ${MAX_DEPOSIT} paise per deposit`, req.body.amount.value);
    if (check.errors.length) throw invalid(check.errors);
  },
  (req) => {
    const account = ownedAccount(req, req.params.id);
    if (account.status === 'CLOSED') throw new ApiError(409, 'ACCOUNT_CLOSED', 'This account is closed.');
    const entry = post(account, 'CREDIT', 'DEPOSIT', req.body.amount.value, 'Sandbox deposit', null);
    return { status: 201, body: entry };
  }
));

function queryTransactions(account) {
  return bank().transactions.filter((t) => t.accountId === account.id);
}

router.get('/accounts/:id/transactions', (req, res) => {
  const account = ownedAccount(req, req.params.id);
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, 'INVALID_PAGINATION', 'page must be 1 or more, and limit must be from 1 to 100.');
  }
  let rows = queryTransactions(account).reverse();
  if (req.query.type) rows = rows.filter((t) => t.type === req.query.type);
  if (req.query.category) rows = rows.filter((t) => t.category === req.query.category);
  if (req.query.minAmount) rows = rows.filter((t) => t.amount.value >= Number(req.query.minAmount));
  if (req.query.maxAmount) rows = rows.filter((t) => t.amount.value <= Number(req.query.maxAmount));
  res.set('X-Total-Count', String(rows.length));
  res.json({ data: rows.slice((page - 1) * limit, page * limit), meta: { page, limit, total: rows.length } });
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
router.get('/accounts/:id/statement', (req, res) => {
  const account = ownedAccount(req, req.params.id);
  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from ?? '2000-01-01';
  const to = req.query.to ?? today;
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new ApiError(400, 'INVALID_DATE_RANGE', 'from and to must be YYYY-MM-DD, with from on or before to.');
  const all = queryTransactions(account);
  const before = all.filter((t) => t.at.slice(0, 10) < from);
  const rows = all.filter((t) => t.at.slice(0, 10) >= from && t.at.slice(0, 10) <= to);
  const openingBalance = before.length ? before[before.length - 1].balanceAfter : 0;
  const sum = (type) => rows.filter((t) => t.type === type).reduce((n, t) => n + t.amount.value, 0);
  const totalCredits = sum('CREDIT');
  const totalDebits = sum('DEBIT');
  const settled = [...bank().transfers.values()].some((t) => t.fromAccountId === account.id && t.status === 'SETTLED');
  if (settled) complete('bank-journey');
  res.vary('Accept');
  if (req.accepts(['application/json', 'text/csv']) === 'text/csv') {
    const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((t) => [t.id, t.at, t.type, t.category, t.amount.value, t.balanceAfter, quote(t.narration)].join(','));
    return res.type('text/csv').send(`id,at,type,category,amountPaise,balanceAfterPaise,narration\n${lines.join('\n')}\n`);
  }
  return res.json({
    account: { id: account.id, accountNumber: account.accountNumber, ifsc: account.ifsc, type: account.type },
    period: { from, to },
    currency: 'INR',
    openingBalance,
    totalCredits,
    totalDebits,
    closingBalance: openingBalance + totalCredits - totalDebits,
    transactions: rows,
  });
});

/* Beneficiaries */
const publicBeneficiary = ({ customerId, ...b }) => b;

function ownedBeneficiary(req, id) {
  const b = bank().beneficiaries.get(id);
  if (!b || b.customerId !== req.customer.id) throw new ApiError(404, 'BENEFICIARY_NOT_FOUND', `No beneficiary with id ${id}.`);
  return b;
}

router.post('/beneficiaries', (req, res) => {
  const body = isObject(req.body) ? req.body : {};
  const check = collector();
  if (typeof body.name !== 'string' || body.name.trim().length < 2) check.fail('name', 'must be at least 2 characters', body.name);
  if (!/^\d{9,18}$/.test(body.accountNumber ?? '')) check.fail('accountNumber', 'must be 9 to 18 digits', body.accountNumber);
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(body.ifsc ?? '')) check.fail('ifsc', 'must look like HDFC0001234', body.ifsc);
  if (check.errors.length) throw invalid(check.errors);
  const internal = body.ifsc === BANK_IFSC;
  if (internal && !bank().accountNumbers.has(body.accountNumber)) {
    throw new ApiError(422, 'DESTINATION_NOT_FOUND', `This bank has no account ${body.accountNumber}.`);
  }
  const duplicate = [...bank().beneficiaries.values()].some((b) => b.customerId === req.customer.id && b.accountNumber === body.accountNumber && b.ifsc === body.ifsc);
  if (duplicate) throw new ApiError(409, 'BENEFICIARY_ALREADY_EXISTS', 'You have already added this beneficiary.');
  const code = newOtp();
  const beneficiary = {
    id: nextId('BEN', 'beneficiary'),
    customerId: req.customer.id,
    name: body.name,
    nickname: body.nickname ?? null,
    accountNumber: body.accountNumber,
    ifsc: body.ifsc,
    internal,
    status: 'PENDING_ACTIVATION',
    createdAt: new Date().toISOString(),
  };
  bank().beneficiaries.set(beneficiary.id, beneficiary);
  bank().beneficiaryOtps.set(beneficiary.id, { code, attempts: 0, expiresAt: Date.now() + OTP_TTL_MS });
  res.status(201).set('Location', `/api/bank/beneficiaries/${beneficiary.id}`).json({ ...publicBeneficiary(beneficiary), devOtp: code, note: OTP_NOTE });
});

router.get('/beneficiaries', (req, res) => {
  const data = [...bank().beneficiaries.values()].filter((b) => b.customerId === req.customer.id).map(publicBeneficiary);
  res.json({ data, meta: { total: data.length } });
});

router.get('/beneficiaries/:id', (req, res) => res.json(publicBeneficiary(ownedBeneficiary(req, req.params.id))));

router.post('/beneficiaries/:id/activate', (req, res) => {
  const beneficiary = ownedBeneficiary(req, req.params.id);
  if (beneficiary.status === 'ACTIVE') throw new ApiError(409, 'BENEFICIARY_ALREADY_ACTIVE', 'This beneficiary is already active.');
  const record = bank().beneficiaryOtps.get(beneficiary.id);
  if (!checkOtp(record, req.body?.otp)) {
    const left = OTP_ATTEMPTS - record.attempts;
    if (left <= 0) {
      bank().beneficiaryOtps.delete(beneficiary.id);
      bank().beneficiaries.delete(beneficiary.id);
      throw new ApiError(401, 'OTP_INVALID', 'Too many wrong codes. Add the beneficiary again.', { attemptsLeft: 0 });
    }
    throw new ApiError(401, 'OTP_INVALID', 'The code is incorrect.', { attemptsLeft: left });
  }
  bank().beneficiaryOtps.delete(beneficiary.id);
  beneficiary.status = 'ACTIVE';
  beneficiary.activatedAt = new Date().toISOString();
  res.json(publicBeneficiary(beneficiary));
});

router.delete('/beneficiaries/:id', (req, res) => {
  const beneficiary = ownedBeneficiary(req, req.params.id);
  bank().beneficiaries.delete(beneficiary.id);
  bank().beneficiaryOtps.delete(beneficiary.id);
  res.status(204).end();
});

/* Transfers */
function spentToday(accountId) {
  const today = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const t of bank().transfers.values()) {
    if (t.fromAccountId === accountId && ['PROCESSING', 'SETTLED'].includes(t.status) && t.createdAt.slice(0, 10) === today) total += t.amount.value;
  }
  return total;
}

function checkRules(account, beneficiary, value, mode) {
  if (account.status === 'FROZEN') {
    complete('bank-frozen');
    throw new ApiError(409, 'ACCOUNT_FROZEN', 'This account is frozen, so money cannot leave it.');
  }
  if (account.status === 'CLOSED') throw new ApiError(409, 'ACCOUNT_CLOSED', 'This account is closed.');
  if (beneficiary.status !== 'ACTIVE') {
    complete('bank-beneficiary-gate');
    throw new ApiError(409, 'BENEFICIARY_NOT_ACTIVE', 'Activate this beneficiary with its code before sending money.');
  }
  if (beneficiary.internal && beneficiary.accountNumber === account.accountNumber) throw new ApiError(422, 'SAME_ACCOUNT', 'The source and destination are the same account.');
  if (mode === 'INTERNAL' && !beneficiary.internal) throw new ApiError(422, 'MODE_NOT_AVAILABLE', 'INTERNAL only works for accounts at this bank.');
  const { min, max } = MODE_RULES[mode];
  if ((min && value < min) || (max && value > max)) {
    throw new ApiError(422, 'MODE_LIMIT_EXCEEDED', `${mode} does not allow this amount.`, { mode, minimum: min ?? null, maximum: max ?? null, requested: value });
  }
  const limit = account.limits.dailyTransferLimit;
  const spent = spentToday(account.id);
  if (spent + value > limit) {
    complete('bank-daily-limit');
    throw new ApiError(422, 'DAILY_LIMIT_EXCEEDED', 'This transfer would go over the daily limit for this account.', { dailyLimit: limit, spentToday: spent, requested: value });
  }
  if (account.balance < value) {
    complete('bank-insufficient');
    throw new ApiError(422, 'INSUFFICIENT_FUNDS', 'The account balance is too low.', { available: account.balance, requested: value });
  }
}

function settle(transfer) {
  if (bank().transfers.get(transfer.id) !== transfer || transfer.status !== 'PROCESSING') return;
  const destinationId = transfer.destination.internal ? bank().accountNumbers.get(transfer.destination.accountNumber) : null;
  const destination = destinationId ? bank().accounts.get(destinationId) : null;
  const value = transfer.amount.value;
  const fails = transfer.destination.internal
    ? !destination || destination.status === 'CLOSED'
    : transfer.destination.accountNumber.endsWith('0000');
  transfer.updatedAt = new Date().toISOString();
  if (fails) {
    const source = bank().accounts.get(transfer.fromAccountId);
    if (source) post(source, 'CREDIT', 'REVERSAL', value, `Reversal of ${transfer.id}`, transfer.id);
    transfer.status = 'REVERSED';
    transfer.failureReason = 'The receiving bank rejected the account. Your money was returned.';
    return;
  }
  if (destination) post(destination, 'CREDIT', 'TRANSFER_IN', value, `From ${transfer.id}`, transfer.id);
  transfer.status = 'SETTLED';
  transfer.settledAt = transfer.updatedAt;
}

function startMoving(transfer, account) {
  post(account, 'DEBIT', 'TRANSFER_OUT', transfer.amount.value, `${transfer.mode} to ${transfer.destination.name}`, transfer.id);
  transfer.status = 'PROCESSING';
  transfer.updatedAt = new Date().toISOString();
  if (['IMPS', 'INTERNAL'].includes(transfer.mode)) {
    settle(transfer);
    return 201;
  }
  const timer = setTimeout(() => settle(transfer), SETTLE_MS);
  timer.unref?.();
  return 202;
}

router.post('/transfers', idempotent(
  (req) => {
    const body = req.body;
    const check = collector();
    if (!isObject(body)) throw invalid([{ path: '$', message: 'must be a JSON object', received: body }]);
    if (typeof body.fromAccountId !== 'string') check.fail('fromAccountId', 'must be a string', body.fromAccountId);
    if (typeof body.beneficiaryId !== 'string') check.fail('beneficiaryId', 'must be a string', body.beneficiaryId);
    checkAmount(body.amount, check);
    if (!Object.keys(MODE_RULES).includes(body.mode)) check.fail('mode', `must be one of ${Object.keys(MODE_RULES).join(', ')}`, body.mode);
    if (body.remarks !== undefined && (typeof body.remarks !== 'string' || body.remarks.length > 140)) check.fail('remarks', 'must be text of at most 140 characters', body.remarks);
    if (check.errors.length) throw invalid(check.errors);
  },
  (req) => {
    const { fromAccountId, beneficiaryId, amount, mode, remarks } = req.body;
    const account = ownedAccount(req, fromAccountId);
    const beneficiary = ownedBeneficiary(req, beneficiaryId);
    checkRules(account, beneficiary, amount.value, mode);
    const now = new Date().toISOString();
    const transfer = {
      id: nextId('TRF', 'transfer'),
      customerId: req.customer.id,
      fromAccountId: account.id,
      beneficiaryId: beneficiary.id,
      destination: { name: beneficiary.name, accountNumber: beneficiary.accountNumber, ifsc: beneficiary.ifsc, internal: beneficiary.internal },
      amount: { value: amount.value, currency: 'INR' },
      mode,
      remarks: remarks ?? null,
      status: 'PENDING_OTP',
      createdAt: now,
      updatedAt: now,
    };
    bank().transfers.set(transfer.id, transfer);
    const headers = { Location: `/api/bank/transfers/${transfer.id}` };
    if (amount.value > OTP_THRESHOLD) {
      const code = newOtp();
      bank().transferOtps.set(transfer.id, { code, attempts: 0, expiresAt: Date.now() + OTP_TTL_MS });
      return { status: 202, headers, body: { ...publicTransfer(transfer), otpRequired: true, devOtp: code, note: OTP_NOTE } };
    }
    const status = startMoving(transfer, account);
    return { status, headers, body: publicTransfer(transfer) };
  }
));

const publicTransfer = ({ customerId, ...t }) => clone(t);

function ownedTransfer(req, id) {
  const t = bank().transfers.get(id);
  if (!t || t.customerId !== req.customer.id) throw new ApiError(404, 'TRANSFER_NOT_FOUND', `No transfer with id ${id}.`);
  return t;
}

router.get('/transfers', (req, res) => {
  let rows = [...bank().transfers.values()].filter((t) => t.customerId === req.customer.id);
  if (req.query.status) rows = rows.filter((t) => t.status === req.query.status);
  if (req.query.accountId) rows = rows.filter((t) => t.fromAccountId === req.query.accountId);
  res.json({ data: rows.map(publicTransfer), meta: { total: rows.length } });
});

router.get('/transfers/:id', (req, res) => {
  const transfer = ownedTransfer(req, req.params.id);
  if (transfer.status === 'REVERSED') complete('bank-reversal');
  res.json(publicTransfer(transfer));
});

router.post('/transfers/:id/confirm', (req, res) => {
  const transfer = ownedTransfer(req, req.params.id);
  if (transfer.status !== 'PENDING_OTP') {
    complete('bank-otp-transfer');
    throw new ApiError(409, 'TRANSFER_NOT_PENDING', `This transfer is already ${transfer.status}, so no money moved this time.`, { status: transfer.status });
  }
  const record = bank().transferOtps.get(transfer.id);
  if (!checkOtp(record, req.body?.otp)) {
    const left = OTP_ATTEMPTS - record.attempts;
    if (left <= 0) {
      transfer.status = 'FAILED';
      transfer.failureReason = 'Too many wrong codes.';
      transfer.updatedAt = new Date().toISOString();
      bank().transferOtps.delete(transfer.id);
    }
    throw new ApiError(401, 'OTP_INVALID', left > 0 ? 'The code is incorrect.' : 'Too many wrong codes. This transfer has been cancelled.', { attemptsLeft: Math.max(left, 0) });
  }
  const account = ownedAccount(req, transfer.fromAccountId);
  const beneficiary = ownedBeneficiary(req, transfer.beneficiaryId);
  checkRules(account, beneficiary, transfer.amount.value, transfer.mode);
  bank().transferOtps.delete(transfer.id);
  const status = startMoving(transfer, account);
  res.status(status === 201 ? 200 : 202).json(publicTransfer(transfer));
});

module.exports = router;
