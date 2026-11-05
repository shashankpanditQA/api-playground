'use strict';
const express = require('express');
const { USERS, ApiError, signJwt, safeEqual, authenticate } = require('../lib');
const { complete } = require('../store');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password, ttlSeconds = 3600 } = req.body || {};
  const details = [];
  if (typeof username !== 'string' || !username) details.push({ path: 'username', message: 'is required' });
  if (typeof password !== 'string' || !password) details.push({ path: 'password', message: 'is required' });
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) {
    details.push({ path: 'ttlSeconds', message: 'must be a whole number from 1 to 86400' });
  }
  if (details.length) throw new ApiError(422, 'VALIDATION_FAILED', 'The login body is invalid.', details);

  const user = Object.prototype.hasOwnProperty.call(USERS, username) ? USERS[username] : null;
  if (!user || !safeEqual(password, user.password)) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
  }

  const now = Math.floor(Date.now() / 1000);
  complete('auth-login');
  res.set('Cache-Control', 'no-store').json({
    accessToken: signJwt({ sub: username, role: user.role, iat: now, exp: now + ttlSeconds }),
    tokenType: 'Bearer',
    expiresIn: ttlSeconds,
    user: { username, role: user.role },
  });
});

router.get('/me', authenticate, (req, res) => res.json({ user: req.user }));

module.exports = router;
