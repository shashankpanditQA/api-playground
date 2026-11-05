'use strict';
/** Banking challenges. Each one creates its own customer, so runs never affect each other. */
const B = '/api/bank';
const TRACK = 'Banking end to end';
const auth = { Authorization: 'Bearer {{token}}' };
const money = (value) => ({ value, currency: 'INR' });

const register = (suffix = '') => ({
  name: suffix ? 'Register a second customer' : 'Register',
  method: 'POST',
  path: `${B}/auth/register`,
  body: {
    fullName: 'Asha Practice',
    email: `{{idemKey}}${suffix}@example.test`,
    phone: '+919800000001',
    password: 'Practice123',
    dateOfBirth: '1995-06-15',
    address: { line1: '1 Test Lane', city: 'Pune', state: 'MH', pincode: '411001' },
  },
  expect: 201,
});
const signIn = (suffix = '') => [
  { name: 'Sign in', method: 'POST', path: `${B}/auth/login`, body: { email: `{{idemKey}}${suffix}@example.test`, password: 'Practice123' }, expect: 200, capture: { mfaToken: 'mfaToken', loginOtp: 'devOtp' } },
  { name: 'Enter the sign-in code', method: 'POST', path: `${B}/auth/otp/verify`, body: { mfaToken: '{{mfaToken}}', otp: '{{loginOtp}}' }, expect: 200, capture: { token: 'accessToken', refreshToken: 'refreshToken' } },
];
const kyc = (pan = 'ABCDE1234F') => [
  { name: 'Submit KYC', method: 'POST', path: `${B}/kyc`, headers: auth, body: { documents: [{ type: 'PAN', number: pan }] }, expect: 202 },
  { name: 'Check KYC status', method: 'GET', path: `${B}/kyc`, headers: auth, expect: 200, waitMs: 1200 },
];
const openAccount = { name: 'Open a savings account', method: 'POST', path: `${B}/accounts`, headers: auth, body: { type: 'SAVINGS' }, expect: 201, capture: { accountId: 'id', accountNumber: 'accountNumber' } };
const deposit = (value = 10000000) => ({ name: 'Deposit money', method: 'POST', path: `${B}/accounts/{{accountId}}/deposits`, headers: { ...auth, 'Idempotency-Key': '{{idemKey}}-dep' }, body: { amount: money(value) }, expect: 201 });
const secondAccount = { name: 'Open a second account', method: 'POST', path: `${B}/accounts`, headers: auth, body: { type: 'CURRENT' }, expect: 201, capture: { secondAccountNumber: 'accountNumber', secondAccountId: 'id' } };
const addBeneficiary = (accountNumber = '{{secondAccountNumber}}', ifsc = 'PLAY0000001') => ({
  name: 'Add a beneficiary',
  method: 'POST',
  path: `${B}/beneficiaries`,
  headers: auth,
  body: { name: 'Ravi Practice', nickname: 'Ravi', accountNumber, ifsc },
  expect: 201,
  capture: { beneficiaryId: 'id', beneficiaryOtp: 'devOtp' },
});
const activate = { name: 'Activate the beneficiary', method: 'POST', path: `${B}/beneficiaries/{{beneficiaryId}}/activate`, headers: auth, body: { otp: '{{beneficiaryOtp}}' }, expect: 200 };
const transfer = (value, mode, expect, extra = {}) => ({
  name: `Send with ${mode}`,
  method: 'POST',
  path: `${B}/transfers`,
  headers: { ...auth, 'Idempotency-Key': '{{idemKey}}-trf' },
  body: { fromAccountId: '{{accountId}}', beneficiaryId: '{{beneficiaryId}}', amount: money(value), mode, remarks: 'Practice transfer' },
  expect,
  ...extra,
});
const setup = [register(), ...signIn(), ...kyc()];
const funded = [...setup, openAccount, deposit(), secondAccount, addBeneficiary(), activate];

const challenge = (id, level, title, task, hint, steps) => ({ id, track: TRACK, level, title, task, hint, steps });

module.exports = [
  challenge('bank-journey', 'Hard', 'Run the full banking journey',
    'Automate the whole flow: register, sign in with a code, pass KYC, open two accounts, deposit, add and activate a beneficiary, transfer, then reconcile. Assert opening + credits - debits = closing on the statement.',
    'Register with a new email on every run. Save values from each response, such as accessToken, account id and beneficiary id, for the next call. DELETE /api/bank/me cleans up afterwards.',
    [
      ...funded,
      transfer(100000, 'IMPS', 201, { capture: { transferId: 'id' } }),
      { name: 'Check the transfer', method: 'GET', path: `${B}/transfers/{{transferId}}`, headers: auth, expect: 200 },
      { name: 'Check the balance', method: 'GET', path: `${B}/accounts/{{accountId}}/balance`, headers: auth, expect: 200 },
      { name: 'List the transactions', method: 'GET', path: `${B}/accounts/{{accountId}}/transactions?type=DEBIT`, headers: auth, expect: 200 },
      { name: 'Get the statement', method: 'GET', path: `${B}/accounts/{{accountId}}/statement`, headers: auth, expect: 200 },
    ]),
  challenge('bank-kyc-gate', 'Easy', 'Open an account before KYC',
    'Try to open an account without passing KYC. Assert 403 KYC_REQUIRED and that no account was created.',
    'Business rules are often missed because tests only follow the correct order of steps.',
    [register(), ...signIn(), { ...openAccount, name: 'Try to open an account', expect: 403 }]),
  challenge('bank-kyc-rejected', 'Medium', 'Handle a rejected KYC',
    'Submit a PAN starting with REJ. Poll until the status is REJECTED, and assert the reason. Then check an account still cannot be opened.',
    'KYC is checked in the background, so poll with a timeout instead of a fixed wait. Use made-up PANs only.',
    [register(), ...signIn(), ...kyc('REJCT1234F')]),
  challenge('bank-lockout', 'Medium', 'Lock an account with wrong passwords',
    'Sign in with a wrong password 5 times. Assert the 5th returns 423 with Retry-After, and that the correct password is also refused while locked.',
    'A wrong password and an unknown email return the same error, so attackers cannot discover who is registered.',
    [register(), { name: 'Sign in with the wrong password', method: 'POST', path: `${B}/auth/login`, body: { email: '{{idemKey}}@example.test', password: 'WrongPassword1' }, repeat: 5, expect: 423 }]),
  challenge('bank-refresh-reuse', 'Hard', 'Reuse a refresh token',
    'Refresh your token, then send the old refresh token again. Assert 401 REFRESH_TOKEN_REUSED, and that the access token from this sign-in stops working.',
    'Refresh tokens work once. A reused token suggests theft, so the whole sign-in is ended.',
    [
      register(), ...signIn(),
      { name: 'Refresh the token', method: 'POST', path: `${B}/auth/refresh`, body: { refreshToken: '{{refreshToken}}' }, expect: 200 },
      { name: 'Reuse the old token', method: 'POST', path: `${B}/auth/refresh`, body: { refreshToken: '{{refreshToken}}' }, expect: 401 },
      { name: 'Try the access token', method: 'GET', path: `${B}/me`, headers: auth, expect: 401 },
    ]),
  challenge('bank-bola', 'Hard', "Read another customer's account",
    "As customer B, request customer A's account. Assert 404, identical to an id that doesn't exist. This is the most common serious API security bug, called BOLA or IDOR.",
    'Try the same with transfers, beneficiaries and statements. Account ids are sequential, so they are easy to guess.',
    [
      ...setup, openAccount,
      register('-b'), ...signIn('-b'),
      { name: "Read customer A's account as B", method: 'GET', path: `${B}/accounts/{{accountId}}`, headers: auth, expect: 404 },
    ]),
  challenge('bank-beneficiary-gate', 'Medium', 'Pay an unactivated beneficiary',
    'Add a beneficiary, skip activation, and send money. Assert 409 BENEFICIARY_NOT_ACTIVE and an unchanged balance.',
    'Three wrong activation codes remove the beneficiary. Test that as well.',
    [...setup, openAccount, deposit(), secondAccount, addBeneficiary(), transfer(100000, 'IMPS', 409)]),
  challenge('bank-transfer-replay', 'Medium', 'Send a transfer twice, debit once',
    'Send one transfer twice with the same Idempotency-Key. Assert the same transfer id, Idempotent-Replayed: true, and a single debit.',
    'Now change the amount with that key and expect 422. Add a test that sends both requests in parallel.',
    [
      ...funded,
      transfer(100000, 'IMPS', 201),
      transfer(100000, 'IMPS', 201, { name: 'Send it again', expectHeaders: { 'idempotent-replayed': 'true' } }),
      { name: 'Confirm one debit', method: 'GET', path: `${B}/accounts/{{accountId}}/transactions?type=DEBIT`, headers: auth, expect: 200 },
    ]),
  challenge('bank-insufficient', 'Easy', 'Send more than the balance',
    'Send more than the account holds. Assert 422 INSUFFICIENT_FUNDS, the available amount in details, and an unchanged balance.',
    'Test the boundaries too: exactly the balance should pass, and one paisa more should fail.',
    [...setup, openAccount, secondAccount, addBeneficiary(), activate, transfer(100000, 'IMPS', 422)]),
  challenge('bank-otp-transfer', 'Hard', 'Approve a large transfer with a code',
    'Transfers above 50,000 rupees need a code. Assert 202 PENDING_OTP with no debit yet, confirm with the code, then confirm again. The second must return 409 with no second debit.',
    'Exactly 50,000 rupees needs no code, and one paisa more does. Three wrong codes cancel the transfer.',
    [
      ...funded,
      transfer(6000000, 'IMPS', 202, { capture: { transferId: 'id', transferOtp: 'devOtp' } }),
      { name: 'Confirm with the code', method: 'POST', path: `${B}/transfers/{{transferId}}/confirm`, headers: auth, body: { otp: '{{transferOtp}}' }, expect: 200 },
      { name: 'Confirm again', method: 'POST', path: `${B}/transfers/{{transferId}}/confirm`, headers: auth, body: { otp: '{{transferOtp}}' }, expect: 409 },
    ]),
  challenge('bank-reversal', 'Hard', 'Follow a failed transfer to its refund',
    'Send NEFT to an outside account ending in 0000. It starts as PROCESSING with the money taken, then becomes REVERSED. Assert the refund appears and the balance is back to where it started.',
    'The first response looks successful. Only polling shows the real outcome.',
    [
      ...setup, openAccount, deposit(),
      addBeneficiary('123456780000', 'HDFC0001234'), activate,
      transfer(100000, 'NEFT', 202, { capture: { transferId: 'id' } }),
      { name: 'Poll until it finishes', method: 'GET', path: `${B}/transfers/{{transferId}}`, headers: auth, expect: 200, waitMs: 2000 },
      { name: 'Find the refund', method: 'GET', path: `${B}/accounts/{{accountId}}/transactions?category=REVERSAL`, headers: auth, expect: 200 },
    ]),
  challenge('bank-frozen', 'Medium', 'Send from a frozen account',
    'Freeze the account, try a transfer and assert 409 ACCOUNT_FROZEN. Unfreeze it, and check the transfer now works with a new key.',
    'Deposits into a frozen account still work. Only money leaving it is blocked.',
    [
      ...funded,
      { name: 'Freeze the account', method: 'POST', path: `${B}/accounts/{{accountId}}/freeze`, headers: auth, expect: 200 },
      transfer(100000, 'IMPS', 409),
    ]),
  challenge('bank-daily-limit', 'Medium', 'Go over the daily limit',
    'Lower the daily limit, then send more than it allows. Assert 422 DAILY_LIMIT_EXCEEDED, with the limit and amount spent in details.',
    'RTGS needs at least 2 lakh rupees and IMPS allows at most 5 lakh. Test those boundaries too.',
    [
      ...funded,
      { name: 'Lower the daily limit', method: 'PATCH', path: `${B}/accounts/{{accountId}}/limits`, headers: auth, body: { dailyTransferLimit: 50000 }, expect: 200 },
      transfer(100000, 'IMPS', 422),
    ]),
];
