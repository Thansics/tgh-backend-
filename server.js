/**
 * TGH Backend — Thansics Grandma's Honey & Broom
 * A small Express server that:
 *  - Serves the frontend (public/index.html)
 *  - Accepts real orders and stores them in orders.json
 *  - Recalculates totals server-side (never trusts prices sent from the browser)
 *  - Exposes a lightweight admin API to view and update orders
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// Change this before going live! Anyone with this key can see all orders.
const ADMIN_KEY = process.env.ADMIN_KEY || 'Thansics01';

// Secret used to sign customer login tokens. CHANGE THIS before going live —
// anyone who knows it could forge a logged-in session. Set JWT_SECRET in
// your real environment (Render dashboard, .env file, etc).
const JWT_SECRET = process.env.JWT_SECRET || 'tgh-dev-secret-change-me';
const TOKEN_EXPIRY = '30d';

// ---------------------------------------------------------
// Simple rate limiting — protects login/register/code endpoints from
// being spammed (which could burn through your email quota, or let
// someone brute-force a password or a 6-digit code). No extra package
// needed — just an in-memory counter per IP per route.
// ---------------------------------------------------------
const rateLimitHits = new Map(); // key: "ip:route" -> [timestamps]

function rateLimit(routeKey, maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${routeKey}`;
    const now = Date.now();
    const hits = (rateLimitHits.get(key) || []).filter(t => now - t < windowMs);

    if (hits.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a bit and try again.' });
    }

    hits.push(now);
    rateLimitHits.set(key, hits);
    next();
  };
}

// Clear out old entries every so often so this map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits.entries()) {
    const fresh = hits.filter(t => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) rateLimitHits.delete(key);
    else rateLimitHits.set(key, fresh);
  }
}, 30 * 60 * 1000).unref();

// ---------------------------------------------------------
// WhatsApp Cloud API (Meta) — optional real order notifications.
// Leave these unset and the server still works fine; it just
// skips sending a WhatsApp message and logs a note instead.
// See README.md for how to get these three values.
// ---------------------------------------------------------
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const GRANDMA_WHATSAPP_NUMBER = process.env.GRANDMA_WHATSAPP_NUMBER || '2347071267515'; // no + or leading zeros

function sendWhatsAppNotification(order) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.log(`ℹ️  WhatsApp not configured — skipping notification for ${order.orderId}.`);
    return;
  }

  const itemLines = order.items.map(i => `${i.quantity}x ${i.name}`).join(', ');
  const bodyText =
    `New TGH order ${order.orderId}\n` +
    `From: ${order.name} (${order.phone})\n` +
    `Items: ${itemLines}\n` +
    `Total: ₦${order.total.toLocaleString('en-NG')}\n` +
    `Deliver to: ${order.address}`;

  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to: GRANDMA_WHATSAPP_NUMBER,
    type: 'text',
    text: { body: bodyText }
  });

  const options = {
    hostname: 'graph.facebook.com',
    path: `/v20.0/${WHATSAPP_PHONE_ID}/messages`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => (data += chunk));
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`✅ WhatsApp notification sent for ${order.orderId}`);
      } else {
        console.error(`⚠️  WhatsApp API error for ${order.orderId}:`, data);
      }
    });
  });

  req.on('error', err => console.error('⚠️  WhatsApp request failed:', err.message));
  req.write(payload);
  req.end();
}

// ---------------------------------------------------------
// Email verification — using Brevo's free email API (brevo.com).
// If BREVO_API_KEY isn't set, the code is just printed to this
// console instead, so you can still test locally before signing up.
// See README.md > "Setting up email verification" for how to get these.
// ---------------------------------------------------------
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const SENDER_EMAIL = process.env.SENDER_EMAIL || '';
const SENDER_NAME = process.env.SENDER_NAME || "Thansics Grandma's Honey";

// Generic email sender — every email in this app (codes, order
// confirmations, status updates) goes through this one function.
function sendEmail({ to, toName, subject, html }, logLabel) {
  if (!BREVO_API_KEY || !SENDER_EMAIL) {
    console.log(`ℹ️  Email not configured — skipped "${subject}" to ${to}.`);
    return;
  }

  const payload = JSON.stringify({
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    to: [{ email: to, name: toName || to }],
    subject,
    htmlContent: html
  });

  const options = {
    hostname: 'api.brevo.com',
    path: '/v3/smtp/email',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'api-key': BREVO_API_KEY,
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => (data += chunk));
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`✅ ${logLabel || 'Email'} sent to ${to}`);
      } else {
        console.error(`⚠️  Email API error for ${to}:`, data);
      }
    });
  });

  req.on('error', err => console.error('⚠️  Email request failed:', err.message));
  req.write(payload);
  req.end();
}

const EMAIL_COPY = {
  verify: {
    subject: 'Your TGH verification code',
    intro: "Welcome to Thansics Grandma's Honey & Broom! Your verification code is:"
  },
  reset: {
    subject: 'Your TGH password reset code',
    intro: 'You asked to reset your TGH password. Your reset code is:'
  }
};

function sendCodeEmail(user, code, purpose) {
  const copy = EMAIL_COPY[purpose] || EMAIL_COPY.verify;
  sendEmail({
    to: user.email,
    toName: user.name,
    subject: copy.subject,
    html:
      `<p>Hi ${user.name},</p>` +
      `<p>${copy.intro}</p>` +
      `<h2 style="letter-spacing:4px;">${code}</h2>` +
      `<p>This code expires in 10 minutes. If you didn't request this, you can ignore this email — your account is safe.</p>`
  }, purpose === 'reset' ? 'Password reset email' : 'Verification email');
}

function sendOrderConfirmationEmail(order) {
  if (!order.email) return;
  const itemLines = order.items.map(i => `${i.quantity}× ${i.name}`).join('<br>');
  sendEmail({
    to: order.email,
    toName: order.name,
    subject: `Order confirmed — ${order.orderId}`,
    html:
      `<p>Hi ${order.name},</p>` +
      `<p>Thanks for your order! Grandma's already getting it ready. Here's a summary:</p>` +
      `<p><strong>Order ID:</strong> ${order.orderId}<br>` +
      `<strong>Items:</strong><br>${itemLines}<br>` +
      `<strong>Total:</strong> ₦${order.total.toLocaleString('en-NG')}<br>` +
      `<strong>Delivering to:</strong> ${order.address}</p>` +
      `<p>We'll let you know as your order moves along.</p>`
  }, 'Order confirmation email');
}

function sendStatusUpdateEmail(order) {
  if (!order.email) return;
  const statusLabels = {
    received: 'Received 📥',
    preparing: 'Being Prepared 🍯',
    out_for_delivery: 'Out for Delivery 🚚',
    completed: 'Completed ✅'
  };
  sendEmail({
    to: order.email,
    toName: order.name,
    subject: `Order ${order.orderId} update: ${statusLabels[order.status] || order.status}`,
    html:
      `<p>Hi ${order.name},</p>` +
      `<p>Your order <strong>${order.orderId}</strong> is now:</p>` +
      `<h3>${statusLabels[order.status] || order.status}</h3>` +
      `<p>Total: ₦${order.total.toLocaleString('en-NG')} · Delivering to: ${order.address}</p>`
  }, 'Order status email');
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

// ---------------------------------------------------------
// Paystack — optional real online payment. Leave the keys unset and
// customers simply won't see a "Pay Now" button; orders still work as
// pay-on-delivery/WhatsApp-coordinated like before.
// See README.md > "Setting up online payment" for how to get these.
// ---------------------------------------------------------
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';

function paystackVerify(reference) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.paystack.co',
      path: `/transaction/verify/${encodeURIComponent(reference)}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------
// Product catalog — the single source of truth for prices.
// The frontend sends product IDs + quantities; the server
// looks up the real price so nobody can tamper with totals.
// ---------------------------------------------------------
const PRODUCTS = {
  'honey-small':  { name: 'Honey — Small Bottle 🍯',       price: 500  },
  'honey-medium': { name: 'Honey — Medium Bottle 🍯',      price: 1000 },
  'honey-large':  { name: 'Honey — Large Bottle 🍯',       price: 3000 },
  'honey-xl':     { name: 'Honey — Extra Large Bottle 🍯', price: 5000 },
  broom:          { name: 'Handwoven Broom 🧹',            price: 200  }
};

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function readOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
  } catch (err) {
    console.error('Could not read orders.json:', err.message);
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function generateOrderId() {
  return 'TGH-' + Math.floor(100000 + Math.random() * 900000);
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Missing or incorrect admin key.' });
  }
  next();
}

// ---------------------------------------------------------
// User accounts (registration & login)
// ---------------------------------------------------------
function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch (err) {
    console.error('Could not read users.json:', err.message);
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function normalizePhone(phone) {
  return String(phone || '').trim().replace(/\s+/g, '');
}

function generateUserId() {
  return 'U-' + crypto.randomBytes(5).toString('hex');
}

function publicUser(user) {
  return {
    id: user.id, name: user.name, phone: user.phone, email: user.email || '',
    address: user.address || '', emailVerified: !!user.emailVerified, createdAt: user.createdAt
  };
}

function signToken(user) {
  return jwt.sign({ sub: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// Attaches req.user if a valid token is present, but never blocks the request.
// Used on /api/orders so guests can still check out.
function attachUserIfPresent(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = readUsers().find(u => u.id === payload.sub);
      if (user) req.user = publicUser(user);
    } catch (err) {
      // invalid/expired token — just proceed as a guest
    }
  }
  next();
}

// Blocks the request unless a valid customer token is present.
function requireUser(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Please log in to continue.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = readUsers().find(u => u.id === payload.sub);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    req.user = publicUser(user);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

// ---------------------------------------------------------
// Public routes
// ---------------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TGH backend', time: new Date().toISOString() });
});

// Current product catalog & prices (frontend can use this to stay in sync)
app.get('/api/products', (req, res) => {
  res.json(PRODUCTS);
});

// ---------------------------------------------------------
// Auth routes — customer registration & login
// ---------------------------------------------------------

// Register a new customer account — not usable yet until the email is verified
app.post('/api/auth/register', rateLimit('register', 5, 60 * 60 * 1000), (req, res) => {
  const { name, phone, email, password, address } = req.body || {};

  if (!name || !phone || !email || !password) {
    return res.status(400).json({ error: 'Please provide a name, phone number, email, and password.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (String(password).length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }

  const cleanPhone = normalizePhone(phone);
  const users = readUsers();
  if (users.some(u => u.phone === cleanPhone)) {
    return res.status(409).json({ error: 'An account with this phone number already exists. Try logging in instead.' });
  }

  const code = generateVerificationCode();
  const user = {
    id: generateUserId(),
    name: String(name).trim(),
    phone: cleanPhone,
    email: String(email).trim().toLowerCase(),
    address: address ? String(address).trim() : '',
    passwordHash: bcrypt.hashSync(String(password), 10),
    emailVerified: false,
    verificationCodeHash: bcrypt.hashSync(code, 8),
    verificationExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    createdAt: new Date().toISOString()
  };

  users.push(user);
  writeUsers(users);

  console.log(`👤 New account pending verification: ${user.name} (${user.phone})`);
  sendCodeEmail(user, code, 'verify');
  res.status(201).json({ pendingVerification: true, phone: user.phone, email: user.email });
});

// Confirm the 6-digit code sent by email — this is what actually unlocks the account
app.post('/api/auth/verify-email', rateLimit('verify-email', 10, 15 * 60 * 1000), (req, res) => {
  const { phone, code } = req.body || {};
  if (!phone || !code) {
    return res.status(400).json({ error: 'Please provide your phone number and the code.' });
  }

  const cleanPhone = normalizePhone(phone);
  const users = readUsers();
  const user = users.find(u => u.phone === cleanPhone);

  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (user.emailVerified) return res.status(400).json({ error: 'This account is already verified — you can log in.' });
  if (!user.verificationCodeHash || new Date(user.verificationExpiresAt) < new Date()) {
    return res.status(400).json({ error: 'That code has expired. Request a new one.' });
  }
  if (!bcrypt.compareSync(String(code).trim(), user.verificationCodeHash)) {
    return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  }

  user.emailVerified = true;
  user.verificationCodeHash = null;
  user.verificationExpiresAt = null;
  writeUsers(users);

  console.log(`✅ Email verified for ${user.name} (${user.phone})`);
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Send a fresh code (if the first one expired or didn't arrive)
app.post('/api/auth/resend-code', rateLimit('resend-code', 5, 15 * 60 * 1000), (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Please provide your phone number.' });

  const cleanPhone = normalizePhone(phone);
  const users = readUsers();
  const user = users.find(u => u.phone === cleanPhone);

  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (user.emailVerified) return res.status(400).json({ error: 'This account is already verified — you can log in.' });

  const code = generateVerificationCode();
  user.verificationCodeHash = bcrypt.hashSync(code, 8);
  user.verificationExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  writeUsers(users);

  sendCodeEmail(user, code, 'verify');
  res.json({ sent: true });
});

// Log in to an existing account
app.post('/api/auth/login', rateLimit('login', 10, 15 * 60 * 1000), (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) {
    return res.status(400).json({ error: 'Please provide your phone number and password.' });
  }

  const cleanPhone = normalizePhone(phone);
  const users = readUsers();
  const user = users.find(u => u.phone === cleanPhone);

  if (!user || !bcrypt.compareSync(String(password), user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect phone number or password.' });
  }

  if (!user.emailVerified) {
    return res.status(403).json({ error: 'Please verify your email before logging in.', needsVerification: true, phone: user.phone });
  }

  res.json({ token: signToken(user), user: publicUser(user) });
});

// ---------------------------------------------------------
// Forgot password — self-serve, via a 6-digit email code
// (same pattern as email verification).
// ---------------------------------------------------------

// Step 1: request a reset code
app.post('/api/auth/forgot-password', rateLimit('forgot-password', 5, 60 * 60 * 1000), (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Please provide your phone number.' });

  const cleanPhone = normalizePhone(phone);
  const users = readUsers();
  const user = users.find(u => u.phone === cleanPhone);

  // Don't reveal whether the phone exists — just respond the same either way.
  if (!user || !user.email) {
    return res.json({ sent: true });
  }

  const code = generateVerificationCode();
  user.resetCodeHash = bcrypt.hashSync(code, 8);
  user.resetExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  writeUsers(users);

  sendCodeEmail(user, code, 'reset');
  res.json({ sent: true });
});

// Step 2: confirm the code + set a new password
app.post('/api/auth/reset-password', rateLimit('reset-password', 10, 15 * 60 * 1000), (req, res) => {
  const { phone, code, newPassword } = req.body || {};
  if (!phone || !code || !newPassword) {
    return res.status(400).json({ error: 'Please provide your phone number, the code, and a new password.' });
  }
  if (String(newPassword).length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  }

  const cleanPhone = normalizePhone(phone);
  const users = readUsers();
  const user = users.find(u => u.phone === cleanPhone);

  if (!user || !user.resetCodeHash || new Date(user.resetExpiresAt) < new Date()) {
    return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
  }
  if (!bcrypt.compareSync(String(code).trim(), user.resetCodeHash)) {
    return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  }

  user.passwordHash = bcrypt.hashSync(String(newPassword), 10);
  user.resetCodeHash = null;
  user.resetExpiresAt = null;
  writeUsers(users);

  console.log(`🔑 Password reset for ${user.name} (${user.phone})`);
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Get the currently logged-in customer's profile
app.get('/api/auth/me', requireUser, (req, res) => {
  res.json({ user: req.user });
});

// Get the currently logged-in customer's past orders
app.get('/api/orders/mine', requireUser, (req, res) => {
  const orders = readOrders().filter(o => o.userId === req.user.id);
  res.json(orders);
});

// ---------------------------------------------------------
// Admin: customer accounts (list, and an admin-assisted password
// reset — there's no email/SMS set up yet, so a self-serve "forgot
// password" email isn't possible; Grandma/the admin resets it by hand
// after confirming the customer's identity over WhatsApp/phone).
// ---------------------------------------------------------

// List every registered customer, newest first
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = readUsers()
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(publicUser);
  res.json(users);
});

// Reset a customer's password (admin sets a new one and shares it with them directly)
app.patch('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  }

  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  user.passwordHash = bcrypt.hashSync(String(newPassword), 10);
  writeUsers(users);
  res.json({ reset: true, user: publicUser(user) });
});

// Delete a customer account
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  let users = readUsers();
  const exists = users.some(u => u.id === req.params.id);
  if (!exists) return res.status(404).json({ error: 'Account not found.' });

  users = users.filter(u => u.id !== req.params.id);
  writeUsers(users);
  res.json({ deleted: req.params.id });
});

// Create a new order
app.post('/api/orders', attachUserIfPresent, (req, res) => {
  const { name, phone, address, email, items } = req.body || {};

  if (!name || !phone || !address || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      error: 'Please provide name, phone, address, and at least one item.'
    });
  }

  // Recompute everything server-side from the trusted PRODUCTS list.
  let total = 0;
  const validatedItems = [];

  for (const item of items) {
    const product = PRODUCTS[item.id];
    if (!product) continue; // ignore unknown product ids
    const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
    total += product.price * quantity;
    validatedItems.push({
      id: item.id,
      name: product.name,
      price: product.price,
      quantity
    });
  }

  if (validatedItems.length === 0) {
    return res.status(400).json({ error: 'No valid items were found in this order.' });
  }

  const orderEmail = email ? String(email).trim() : (req.user ? req.user.email : '');

  const order = {
    orderId: generateOrderId(),
    userId: req.user ? req.user.id : null, // set when the customer is logged in; null for guest checkout
    name: String(name).trim(),
    phone: String(phone).trim(),
    email: orderEmail,
    address: String(address).trim(),
    items: validatedItems,
    total,
    status: 'received', // received -> preparing -> out_for_delivery -> completed
    paymentStatus: 'unpaid', // unpaid -> paid (set once Paystack verifies the payment)
    paystackReference: null,
    createdAt: new Date().toISOString()
  };

  const orders = readOrders();
  orders.unshift(order);
  writeOrders(orders);

  console.log(`🍯 New order ${order.orderId} from ${order.name} — ₦${order.total}`);
  sendWhatsAppNotification(order);
  sendOrderConfirmationEmail(order);
  res.status(201).json(order);
});

// ---------------------------------------------------------
// Payments (Paystack)
// ---------------------------------------------------------

// Tells the frontend whether online payment is available, and gives it
// the PUBLIC key (safe to expose — never the secret key).
app.get('/api/payments/config', (req, res) => {
  res.json({ enabled: !!(PAYSTACK_PUBLIC_KEY && PAYSTACK_SECRET_KEY), publicKey: PAYSTACK_PUBLIC_KEY });
});

// Verify a payment after the customer completes Paystack's checkout popup.
// This is the step that actually marks an order as paid — never trust the
// frontend's word for it, always confirm with Paystack server-to-server.
app.post('/api/payments/verify', async (req, res) => {
  const { reference, orderId } = req.body || {};
  if (!reference || !orderId) {
    return res.status(400).json({ error: 'Missing payment reference or order ID.' });
  }
  if (!PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: 'Online payment is not configured yet.' });
  }

  const orders = readOrders();
  const order = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  try {
    const result = await paystackVerify(reference);
    const txn = result && result.data;

    if (!txn || result.status !== true || txn.status !== 'success') {
      return res.status(400).json({ error: 'Payment was not successful.' });
    }
    // Paystack amounts are in kobo — confirm it matches what this order actually costs.
    if (txn.amount !== order.total * 100) {
      console.error(`⚠️  Payment amount mismatch for ${order.orderId}: expected ₦${order.total}, paid ${txn.amount / 100}`);
      return res.status(400).json({ error: 'Payment amount does not match the order total.' });
    }

    order.paymentStatus = 'paid';
    order.paystackReference = reference;
    writeOrders(orders);

    console.log(`💳 Payment confirmed for ${order.orderId} — ₦${order.total}`);
    res.json({ verified: true, order });
  } catch (err) {
    console.error('⚠️  Payment verification failed:', err.message);
    res.status(502).json({ error: 'Could not verify payment right now. Please try again.' });
  }
});

// Look up a single order (for order tracking / confirmation pages)
app.get('/api/orders/:id', (req, res) => {
  const orders = readOrders();
  const order = orders.find(o => o.orderId === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json(order);
});

// ---------------------------------------------------------
// Admin routes (protected by X-Admin-Key header)
// ---------------------------------------------------------

// List every order, newest first
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json(readOrders());
});

// Update an order's status (e.g. mark as "preparing" or "completed")
app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  const orders = readOrders();
  const order = orders.find(o => o.orderId === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const statusChanged = status && status !== order.status;
  order.status = status || order.status;
  writeOrders(orders);

  if (statusChanged) sendStatusUpdateEmail(order);
  res.json(order);
});

// Delete an order
app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  let orders = readOrders();
  const exists = orders.some(o => o.orderId === req.params.id);
  if (!exists) return res.status(404).json({ error: 'Order not found.' });

  orders = orders.filter(o => o.orderId !== req.params.id);
  writeOrders(orders);
  res.json({ deleted: req.params.id });
});

app.listen(PORT, () => {
  console.log(`🍯 TGH backend running at http://localhost:${PORT}`);
  console.log(`👵 Admin dashboard at   http://localhost:${PORT}/admin.html`);
});
