'use strict';
const express = require('express');
const { ApiError, authenticate, requireRole, clone, getPath, isObject, mergePatch } = require('../lib');
const { state, computeTotals, complete } = require('../store');

const router = express.Router();
router.use(authenticate);

const STATUSES = ['PLACED', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const TRANSITIONS = {
  PLACED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};
const READ_ONLY = ['id', 'version', 'totals', 'createdAt', 'updatedAt'];
const etagOf = (order) => `"v${order.version}"`;

function validateOrderBody(body) {
  const errors = [];
  const fail = (path, message, received) => errors.push({ path, message, received: received === undefined ? null : received });
  const text = (value, path, pattern) => {
    if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a non-empty string', value);
    else if (pattern && !pattern.test(value)) fail(path, `must match ${pattern}`, value);
  };

  if (!isObject(body)) {
    fail('$', 'body must be a JSON object', body);
    return errors;
  }
  const { customer, items } = body;
  if (!isObject(customer)) fail('customer', 'must be an object', customer);
  else {
    text(customer.name, 'customer.name');
    if (!isObject(customer.contact)) fail('customer.contact', 'must be an object', customer.contact);
    else {
      text(customer.contact.email, 'customer.contact.email', /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
      if (customer.contact.phones !== undefined) {
        if (!Array.isArray(customer.contact.phones)) fail('customer.contact.phones', 'must be an array', customer.contact.phones);
        else {
          customer.contact.phones.forEach((phone, i) => {
            text(phone?.number, `customer.contact.phones[${i}].number`, /^\+\d{10,15}$/);
          });
        }
      }
    }
    if (!isObject(customer.address)) fail('customer.address', 'must be an object', customer.address);
    else {
      text(customer.address.city, 'customer.address.city');
      text(customer.address.pincode, 'customer.address.pincode', /^\d{6}$/);
      const { geo } = customer.address;
      if (geo !== undefined) {
        if (!isObject(geo)) fail('customer.address.geo', 'must be an object', geo);
        else {
          if (typeof geo.lat !== 'number' || geo.lat < -90 || geo.lat > 90) fail('customer.address.geo.lat', 'must be a number from -90 to 90', geo.lat);
          if (typeof geo.lng !== 'number' || geo.lng < -180 || geo.lng > 180) fail('customer.address.geo.lng', 'must be a number from -180 to 180', geo.lng);
        }
      }
    }
  }

  if (!Array.isArray(items) || !items.length) fail('items', 'must be a non-empty array', items);
  else {
    const seen = new Set();
    items.forEach((item, i) => {
      const at = `items[${i}]`;
      if (!isObject(item)) return fail(at, 'must be an object', item);
      text(item.sku, `${at}.sku`);
      if (seen.has(item.sku)) fail(`${at}.sku`, 'is a duplicate within this order', item.sku);
      seen.add(item.sku);
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) fail(`${at}.quantity`, 'must be a whole number from 1 to 100', item.quantity);
      if (!isObject(item.unitPrice)) fail(`${at}.unitPrice`, 'must be an object', item.unitPrice);
      else {
        if (!Number.isInteger(item.unitPrice.value) || item.unitPrice.value < 1) fail(`${at}.unitPrice.value`, 'must be a positive whole number of paise', item.unitPrice.value);
        if (item.unitPrice.currency !== 'INR') fail(`${at}.unitPrice.currency`, 'must be INR', item.unitPrice.currency);
      }
      if (item.discounts !== undefined) {
        if (!Array.isArray(item.discounts)) fail(`${at}.discounts`, 'must be an array', item.discounts);
        else {
          item.discounts.forEach((d, j) => {
            text(d?.code, `${at}.discounts[${j}].code`);
            if (typeof d?.percent !== 'number' || d.percent <= 0 || d.percent > 100) fail(`${at}.discounts[${j}].percent`, 'must be above 0 and at most 100', d?.percent);
          });
        }
      }
      return undefined;
    });
  }
  return errors;
}

function normalise(body) {
  const copy = clone(body);
  copy.customer.contact.phones ||= [];
  copy.items = copy.items.map((item) => ({ options: {}, discounts: [], ...item }));
  return copy;
}

function findOrder(id) {
  const order = state.orders.get(id);
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `No order with id ${id}.`);
  return order;
}

function checkIfMatch(req, order, required) {
  const header = req.get('if-match');
  if (!header) {
    if (!required) return;
    throw new ApiError(428, 'PRECONDITION_REQUIRED', 'PUT needs an If-Match header carrying the ETag you last read.');
  }
  if (header !== '*' && header !== etagOf(order)) {
    complete('nested-lost-update');
    throw new ApiError(412, 'VERSION_CONFLICT', 'Someone changed this order after you read it. Read it again, then retry.', {
      yourVersion: header,
      currentVersion: etagOf(order),
    });
  }
}

function checkTransition(from, to) {
  if (to === from) return;
  if (!STATUSES.includes(to)) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'The order is invalid.', [{ path: 'status', message: `must be one of ${STATUSES.join(', ')}`, received: to }]);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', `An order cannot move from ${from} to ${to}.`, { allowed: TRANSITIONS[from] });
  }
}

function pickFields(order, fields) {
  const out = {};
  for (const field of fields.split(',').map((f) => f.trim()).filter(Boolean)) {
    const found = getPath(order, field);
    if (!found.found) continue;
    const parts = field.split('.');
    let node = out;
    parts.slice(0, -1).forEach((part) => {
      node[part] ||= {};
      node = node[part];
    });
    node[parts[parts.length - 1]] = found.value;
  }
  return out;
}

router.get('/', (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, 'INVALID_PAGINATION', 'page must be 1 or more, and limit must be from 1 to 100.');
  }
  const reserved = new Set(['page', 'limit', 'sort', 'minTotal', 'maxTotal']);
  let rows = [...state.orders.values()];
  let nestedFilter = false;
  for (const [key, value] of Object.entries(req.query)) {
    if (reserved.has(key)) continue;
    if (key.includes('.')) nestedFilter = true;
    rows = rows.filter((row) => {
      const found = getPath(row, key);
      return found.found && String(found.value).toLowerCase() === String(value).toLowerCase();
    });
  }
  if (nestedFilter) complete('nested-filter');
  if (req.query.minTotal) rows = rows.filter((r) => r.totals.grandTotal >= Number(req.query.minTotal));
  if (req.query.maxTotal) rows = rows.filter((r) => r.totals.grandTotal <= Number(req.query.maxTotal));
  if (req.query.sort) {
    const descending = req.query.sort.startsWith('-');
    const field = descending ? req.query.sort.slice(1) : req.query.sort;
    rows.sort((a, b) => {
      const left = getPath(a, field).value;
      const right = getPath(b, field).value;
      if (left === right) return 0;
      return (left > right ? 1 : -1) * (descending ? -1 : 1);
    });
  }
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const data = rows.slice((page - 1) * limit, page * limit);
  const base = `/api/orders?limit=${limit}`;
  const links = [`<${base}&page=1>; rel="first"`, `<${base}&page=${pages}>; rel="last"`];
  if (page < pages) links.push(`<${base}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${base}&page=${page - 1}>; rel="prev"`);
  res.set({ 'X-Total-Count': String(total), Link: links.join(', ') });
  res.json({ data, meta: { page, limit, total, pages } });
});

router.post('/', requireRole('admin', 'tester'), (req, res) => {
  const errors = validateOrderBody(req.body);
  if (errors.length) {
    if (errors.some((e) => /\[\d+\]\./.test(e.path))) complete('nested-field-error');
    throw new ApiError(422, 'VALIDATION_FAILED', `The order has ${errors.length} invalid field(s).`, errors);
  }
  const body = normalise(req.body);
  state.orderSeq += 1;
  const now = new Date().toISOString();
  const order = {
    id: `ORD-${state.orderSeq}`,
    status: 'PLACED',
    version: 1,
    customer: body.customer,
    items: body.items,
    shipments: [],
    totals: computeTotals(body.items),
    createdAt: now,
    updatedAt: now,
  };
  state.orders.set(order.id, order);
  complete('nested-create');
  res.status(201).set({ Location: `/api/orders/${order.id}`, ETag: etagOf(order) }).json(order);
});

router.get('/:id', (req, res) => {
  const order = findOrder(req.params.id);
  res.set('ETag', etagOf(order));
  if (req.get('if-none-match') === etagOf(order)) return res.status(304).end();
  return res.json(req.query.fields ? pickFields(order, req.query.fields) : order);
});

router.get('/:id/items/:sku', (req, res) => {
  const order = findOrder(req.params.id);
  const item = order.items.find((i) => i.sku === req.params.sku);
  if (!item) throw new ApiError(404, 'ITEM_NOT_FOUND', `Order ${order.id} has no item ${req.params.sku}.`);
  res.json(item);
});

function saveUpdate(order, next) {
  next.id = order.id;
  next.version = order.version + 1;
  next.createdAt = order.createdAt;
  next.updatedAt = new Date().toISOString();
  next.shipments ||= order.shipments;
  next.totals = computeTotals(next.items);
  state.orders.set(order.id, next);
  return next;
}

router.put('/:id', requireRole('admin', 'tester'), (req, res) => {
  const order = findOrder(req.params.id);
  checkIfMatch(req, order, true);
  const errors = validateOrderBody(req.body);
  if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', `The order has ${errors.length} invalid field(s).`, errors);
  const status = req.body.status ?? order.status;
  checkTransition(order.status, status);
  const body = normalise(req.body);
  const saved = saveUpdate(order, { status, customer: body.customer, items: body.items, shipments: body.shipments });
  res.set('ETag', etagOf(saved)).json(saved);
});

router.patch('/:id', requireRole('admin', 'tester'), (req, res) => {
  const order = findOrder(req.params.id);
  checkIfMatch(req, order, false);
  if (!isObject(req.body)) throw new ApiError(422, 'VALIDATION_FAILED', 'A merge patch must be a JSON object.');
  const blocked = READ_ONLY.filter((field) => field in req.body);
  if (blocked.length) {
    throw new ApiError(422, 'READ_ONLY_FIELD', 'These fields are managed by the server.', blocked.map((path) => ({ path, message: 'is read-only' })));
  }
  const merged = mergePatch(order, req.body);
  const errors = validateOrderBody(merged);
  if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', `The patched order has ${errors.length} invalid field(s).`, errors);
  checkTransition(order.status, merged.status);
  const saved = saveUpdate(order, merged);
  if (Object.values(req.body).some(isObject)) complete('nested-merge-patch');
  res.set('ETag', etagOf(saved)).json(saved);
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  findOrder(req.params.id);
  state.orders.delete(req.params.id);
  res.status(204).end();
});

module.exports = router;
