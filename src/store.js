'use strict';
const fs = require('fs');
const path = require('path');

const PROGRESS_FILE =
  process.env.PROGRESS_FILE === 'off'
    ? null
    : process.env.PROGRESS_FILE || path.join(__dirname, '..', '.progress.json');

function loadProgress() {
  if (!PROGRESS_FILE) return {};
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const progress = loadProgress();

function complete(challengeId) {
  if (progress[challengeId]) return;
  progress[challengeId] = new Date().toISOString();
  if (!PROGRESS_FILE) return;
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch {
    /* Progress still works in memory if the folder is read-only. */
  }
}

function clearProgress() {
  for (const key of Object.keys(progress)) delete progress[key];
  if (!PROGRESS_FILE) return;
  try {
    fs.rmSync(PROGRESS_FILE, { force: true });
  } catch {
    /* Nothing to clean up. */
  }
}

function seedOrders() {
  const order = (id, status, customer, items, shipments, createdAt) => ({
    id,
    status,
    version: 1,
    customer,
    items,
    shipments,
    totals: computeTotals(items),
    createdAt,
    updatedAt: createdAt,
  });

  return new Map(
    [
      order(
        'ORD-1001',
        'PLACED',
        {
          id: 'CUS-1',
          name: 'Asha Rao',
          contact: { email: 'asha@example.test', phones: [{ type: 'mobile', number: '+919800000001' }] },
          address: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001', geo: { lat: 12.9756, lng: 77.6066 } },
        },
        [
          {
            sku: 'KB-MECH-87',
            name: 'Mechanical keyboard',
            quantity: 1,
            unitPrice: { value: 549900, currency: 'INR' },
            options: { switch: 'brown', layout: 'TKL' },
            discounts: [{ code: 'WELCOME10', percent: 10 }],
          },
          {
            sku: 'USB-C-1M',
            name: 'USB-C cable',
            quantity: 2,
            unitPrice: { value: 49900, currency: 'INR' },
            options: {},
            discounts: [],
          },
        ],
        [],
        '2026-01-10T09:30:00.000Z'
      ),
      order(
        'ORD-1002',
        'SHIPPED',
        {
          id: 'CUS-2',
          name: 'Ravi Menon',
          contact: { email: 'ravi@example.test', phones: [] },
          address: { line1: '4 Marine Drive', city: 'Kochi', pincode: '682031', geo: { lat: 9.9816, lng: 76.2755 } },
        },
        [
          {
            sku: 'MON-27-4K',
            name: '27 inch 4K monitor',
            quantity: 1,
            unitPrice: { value: 3299900, currency: 'INR' },
            options: { stand: 'ergonomic' },
            discounts: [],
          },
        ],
        [
          {
            carrier: 'BlueLine',
            trackingId: 'BL-778812',
            events: [
              { status: 'PICKED_UP', at: '2026-01-12T06:00:00.000Z', location: { city: 'Mumbai' } },
              { status: 'IN_TRANSIT', at: '2026-01-13T11:15:00.000Z', location: { city: 'Pune' } },
            ],
          },
        ],
        '2026-01-11T14:10:00.000Z'
      ),
      order(
        'ORD-1003',
        'DELIVERED',
        {
          id: 'CUS-1',
          name: 'Asha Rao',
          contact: { email: 'asha@example.test', phones: [] },
          address: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001', geo: { lat: 12.9756, lng: 77.6066 } },
        },
        [
          {
            sku: 'MOUSE-WL',
            name: 'Wireless mouse',
            quantity: 3,
            unitPrice: { value: 129900, currency: 'INR' },
            options: { colour: 'graphite' },
            discounts: [{ code: 'BULK5', percent: 5 }],
          },
        ],
        [],
        '2026-01-05T08:00:00.000Z'
      ),
    ].map((o) => [o.id, o])
  );
}

function computeTotals(items) {
  let subtotal = 0;
  let discount = 0;
  for (const item of items) {
    const line = item.quantity * item.unitPrice.value;
    subtotal += line;
    for (const d of item.discounts || []) discount += Math.round((line * d.percent) / 100);
  }
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * 0.18);
  return { currency: 'INR', subtotal, discount, tax, grandTotal: taxable + tax };
}

function seedAccounts() {
  const account = (id, owner, balance) => ({ id, owner, currency: 'INR', balance });
  return new Map(
    [
      account('ACC-1001', 'Asha Rao', 5000000),
      account('ACC-1002', 'Ravi Menon', 100000),
      account('ACC-9001', 'Playground Store (merchant)', 0),
    ].map((a) => [a.id, a])
  );
}

function seedMocks() {
  return [
    {
      id: 'mock_sample_user',
      name: 'Sample: templated user',
      method: 'GET',
      path: '/sample/users/:id',
      priority: 0,
      match: {},
      responses: [
        {
          status: 200,
          headers: { 'X-Mocked-By': 'api-playground' },
          body: { id: '{{params.id}}', name: 'Mock User', requestedAt: '{{now}}', traceId: '{{uuid}}' },
          delayMs: 0,
        },
      ],
      afterLast: 'repeatLast',
      hits: 0,
      calls: [],
      createdAt: new Date().toISOString(),
    },
  ];
}

const state = {};

function resetData() {
  state.orders = seedOrders();
  state.orderSeq = 1003;
  state.accounts = seedAccounts();
  state.payments = new Map();
  state.paymentSeq = 0;
  state.refundSeq = 0;
  state.ledger = [];
  state.idempotency = new Map();
  state.failedOnce = new Set();
  state.mocks = seedMocks();
  state.mockSeq = 0;
  state.flaky = new Map();
  state.rateLimits = new Map();
  state.jobs = new Map();
  state.jobSeq = 0;
  state.batches = 0;
  state.driftCalls = 0;
  state.lastUnsafe = null;
}

resetData();

module.exports = { state, resetData, computeTotals, progress, complete, clearProgress };
