# TGH Backend — Thansics Grandma's Honey & Broom

A real backend for the TGH platform, built with **Node.js + Express**.
It serves the storefront, accepts real orders, stores them, and gives
you (or Grandma) an admin dashboard to see and manage every order.

## What's inside

```
tgh-backend/
├── server.js        ← the backend server (Express + WhatsApp notifications)
├── package.json      ← dependencies
├── render.yaml         ← one-click Render deployment config
├── .env.example        ← template for your environment variables
├── orders.json        ← where orders are stored (auto-created/updated)
├── users.json          ← customer accounts, passwords safely hashed (auto-created/updated)
├── public/
│   ├── index.html      ← the storefront (hero, products, cart, checkout)
│   ├── admin.html      ← the orders & customers dashboard
│   └── terms.html      ← Terms & Privacy page (linked in the footer)
└── README.md
```

## 1. Install requirements

You need **Node.js** installed (version 16 or newer). Check with:

```bash
node -v
```

If you don't have it, download it from https://nodejs.org (choose the LTS version).

## 2. Install dependencies

Open a terminal inside the `tgh-backend` folder and run:

```bash
npm install
```

This downloads Express and CORS (the only two packages this project needs).

## 3. Start the server

```bash
npm start
```

You should see:

```
🍯 TGH backend running at http://localhost:3000
👵 Admin dashboard at   http://localhost:3000/admin.html
```

## 4. Open the platform

- **Storefront:** http://localhost:3000
- **Admin dashboard:** http://localhost:3000/admin.html
  - Default admin key: `Thansics01`
  - **Change this before sharing the link with anyone** (see below).

Now when a customer fills the cart and places an order, it's sent to the
server, saved in `orders.json`, and shows up instantly on the admin
dashboard — no more simulated/fake confirmation.

## 5. Change the admin key (important!)

Anyone who knows the admin key can see every customer's name, phone
number, and address. Before you put this online, change the key:

```bash
# Mac/Linux
ADMIN_KEY=your-new-secret-key npm start

# Windows (Command Prompt)
set ADMIN_KEY=your-new-secret-key && npm start
```

Or create a file named `.env`... actually this project reads it from the
environment directly, so just set `ADMIN_KEY` however your hosting
provider lets you set environment variables (most hosts have a settings
page for this).

## 6. Customer accounts (registration, email verification & login)

Customers can create an account (name, phone, email, password) right
on the storefront, log in, and see their own order history — no more
re-typing their name/phone/address every time they order.

How it works:
- Accounts are stored in `users.json` (created automatically), with
  passwords safely hashed — never stored as plain text.
- **Email verification is required.** Right after registering, a
  6-digit code is emailed to the customer. They can't log in until
  they enter that code — this confirms the email is real and theirs.
  The code expires after 10 minutes, and there's a "Resend code" link
  if it doesn't arrive in time.
- Logging in gives the browser a login token (JWT) that's saved in
  `localStorage` and sent along with orders, so each order gets linked
  to the account that placed it.
- Customers **don't have to** create an account — guest checkout still
  works exactly as before.
- Just like the admin key, set your own `JWT_SECRET` before going live
  (see `.env.example`) — otherwise anyone who finds the default could
  forge a login.
- **Forgot password:** fully self-serve now. A customer taps "Reset it
  here" on the login screen, enters their phone number, and gets a
  6-digit code emailed to the address on file. Entering that code (plus
  a new password) logs them straight in with the new password set —
  no admin involvement needed. (You can still reset someone's password
  manually from the **Customers** tab in `/admin.html` too, if they
  ever lose access to their email.)
- The admin dashboard's **Customers** tab lists everyone who's
  registered (name, phone, email, verified ✅/⏳, address, join date),
  and lets you delete an account if needed — their past orders stay on
  record either way.

New endpoints: `POST /api/auth/register`, `POST /api/auth/verify-email`,
`POST /api/auth/resend-code`, `POST /api/auth/login`,
`POST /api/auth/forgot-password`, `POST /api/auth/reset-password`,
`GET /api/auth/me`, `GET /api/orders/mine`, `GET /api/admin/users`,
`PATCH /api/admin/users/:id/reset-password`, `DELETE /api/admin/users/:id`
(all documented in the API reference below).

## 7. Setting up email verification

New accounts won't receive a real email until you connect a free email
service called **Brevo** (formerly Sendinblue). Until you do, the
verification code just gets printed to your server's console/logs —
fine for testing, not for real customers.

1. Go to [brevo.com](https://www.brevo.com) and sign up for a free account
   (300 emails/day free — plenty for a small shop)
2. Verify your own email address with them (they'll ask once you sign up)
3. In Brevo, go to **SMTP & API** (under your account/settings) and
   generate a new **API key**
4. Set these as environment variables wherever you deploy (Render's
   dashboard, Replit's Secrets tab, etc — see `.env.example`):
   - `BREVO_API_KEY` — the key you just generated
   - `SENDER_EMAIL` — the email address you verified with Brevo (this
     is who the verification emails come "from")
   - `SENDER_NAME` — optional, defaults to "Thansics Grandma's Honey"
5. Restart the server — new signups will now get a real email with
   their code

## 8. Editing prices or products

Prices live in **one place** — `server.js`, near the top, in the
`PRODUCTS` object. Edit them there and restart the server; the backend
is the source of truth, so prices can't be tampered with from the browser.

## 9. Setting up online payment

Right now customers can order, but paying happens off-platform
(cash/WhatsApp). Adding **Paystack** lets them actually pay on the
site with a card, bank transfer, or USSD — a big step toward feeling
like a "real" shop.

1. Go to [paystack.com](https://paystack.com) and create a free account
2. Once logged in, go to **Settings → API Keys & Webhooks**
3. Copy your **Test Secret Key** and **Test Public Key** (start with
   test mode — switch to Live keys only once you're ready for real
   transactions, which requires Paystack to verify your business)
4. Set these as environment variables wherever you deploy:
   - `PAYSTACK_SECRET_KEY`
   - `PAYSTACK_PUBLIC_KEY`
5. Restart the server — a **"💳 Pay Online Now"** button will now
   appear after checkout

How it works: the customer places their order as normal (pay-on-delivery
still works too — paying online is optional, not forced). If they tap
"Pay Online Now," Paystack's secure popup opens; once they pay, the
backend double-checks the payment really went through — and that the
amount matches the order — directly with Paystack's servers before
marking the order "paid." The browser is never trusted on its own
about whether payment succeeded.

## 10. Trust & safety features already built in

A few things that make this a legitimate, safer platform for real
customers — already active, no setup needed:

- **Passwords are hashed**, never stored as plain text
- **Email verification** — no one can use an account without proving
  they own that email (see section 6)
- **Rate limiting** on login, registration, and code-based endpoints —
  stops someone from spamming requests or brute-forcing a password/code
- **Server-side price validation** — the browser can never send a
  tampered price; the server always recalculates totals itself
- **Payment amounts are double-checked** against the real order total
  before anything is marked "paid"
- **Input is escaped** before being displayed in the admin dashboard,
  so a customer can't inject malicious code through their name/phone/
  address fields
- **Terms & Privacy page** (`public/terms.html`, linked in the footer)
  — explains what data is collected and how it's used, so customers
  know what they're agreeing to

## 11. Putting it online (so the QR code & share link work for real)

Right now this only runs on your own computer (`localhost`). Here's the
exact path to get it on the internet using **Render** (free tier, no
credit card needed for this project size):

1. **Create a GitHub account** if you don't have one → https://github.com/signup
2. **Create a new repository** (github.com → the "+" icon → New repository).
   Name it something like `tgh-platform`. Leave it empty (no README).
3. **Push this folder to that repository.** In a terminal, inside the
   `tgh-backend` folder:
   ```bash
   git init
   git add .
   git commit -m "TGH platform"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/tgh-platform.git
   git push -u origin main
   ```
4. **Create a Render account** → https://render.com (sign up with GitHub,
   it's the fastest way).
5. On the Render dashboard, click **New +** → **Blueprint**, then select
   your `tgh-platform` repo. Render will read the `render.yaml` file
   already included in this project and set everything up automatically.
6. Render will ask you to fill in the environment variables marked
   `sync: false` — that's `ADMIN_KEY` (pick your own secret password) and,
   later, the WhatsApp values from step 8 below.
7. Click **Apply** / **Deploy**. In a minute or two you'll get a live URL
   like `https://tgh-platform.onrender.com`.

That URL is now real. Open it, and the "Share" section's QR code and
copy-link button will automatically point to it — scan it with any
phone and the store opens.

> **Free-tier note:** Render's free web services "sleep" after periods
> of no traffic and take ~30–50 seconds to wake up on the next visit.
> That's fine for testing; if it matters for real customers later, a
> paid Render plan (from ~$7/month) keeps it always-on.

## 12. Setting up real WhatsApp order alerts

This sends Grandma an automatic WhatsApp message the moment a new order
comes in, using Meta's official **WhatsApp Cloud API**. It's free to use,
but it does require verifying a business with Meta — there's no way
around that step since it's how WhatsApp prevents spam. Here's the path:

1. **Create a Meta Developer account** → https://developers.facebook.com
   (log in with a Facebook account, or create one).
2. Go to **My Apps → Create App**. Choose **"Other"** as the use case,
   then **"Business"** as the app type. Give it a name like "TGH Orders".
3. On the app dashboard, find **WhatsApp** in the product list and click
   **Set up**.
4. Meta gives you a **free test phone number** automatically — good
   enough to try this out immediately without any business verification.
   On that setup page you'll see:
   - A **Phone Number ID** → this is `WHATSAPP_PHONE_ID`
   - A **Temporary Access Token** (valid ~24 hours, fine for testing)
     → this is `WHATSAPP_TOKEN`
5. Under **"To"**, add Grandma's number (`07071267515`) as a test
   recipient, and verify it with the code WhatsApp sends to that phone.
6. Copy those two values into Render's environment variables
   (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`) — or into a local `.env` file
   if testing on your computer — and redeploy/restart.
7. Place a test order on the site. Grandma's phone should get a WhatsApp
   message with the order details within seconds.

**To make this permanent (not a 24-hour test token):**
- Complete **Meta Business Verification** (Meta asks for a business name,
  address, and a document like a business registration or utility bill —
  this can take anywhere from a few hours to a few days for Meta to
  review).
- Once verified, generate a **permanent System User access token**
  instead of the temporary one, and optionally buy/register a real phone
  number for WhatsApp Business instead of using the free test number.

This part genuinely can't be done by anyone but you — Meta requires the
account holder to prove they own the business. I've done everything on
the code side, though: the server already has a working
`sendWhatsAppNotification()` function wired into every new order, so the
moment you drop in real credentials, it just works — no code changes
needed.


## API reference (for reference / future features)

| Method | Endpoint                 | Description                                  |
|--------|---------------------------|-----------------------------------------------|
| GET    | `/api/health`             | Check the server is alive                     |
| GET    | `/api/products`           | Get the current product catalog & prices      |
| POST   | `/api/auth/register`      | Create a customer account (sends a verification code) |
| POST   | `/api/auth/verify-email`  | Confirm the code, activates the account & logs in |
| POST   | `/api/auth/resend-code`   | Send a fresh verification code                |
| POST   | `/api/auth/login`         | Log in, returns a login token (blocked until verified) |
| POST   | `/api/auth/forgot-password` | Email a password reset code                 |
| POST   | `/api/auth/reset-password`  | Confirm the code + set a new password, logs in |
| GET    | `/api/auth/me`            | Get the logged-in customer's profile (needs token) |
| GET    | `/api/orders/mine`        | List the logged-in customer's past orders (needs token) |
| GET    | `/api/admin/users`        | List all registered customers (needs admin key) |
| PATCH  | `/api/admin/users/:id/reset-password` | Reset a customer's password (needs admin key) |
| DELETE | `/api/admin/users/:id`    | Delete a customer account (needs admin key)   |
| POST   | `/api/orders`              | Place a new order (works logged in or as guest) |
| GET    | `/api/payments/config`    | Whether online payment is set up (+ the public key) |
| POST   | `/api/payments/verify`    | Confirm a Paystack payment, marks the order paid |
| GET    | `/api/orders/:id`          | Look up one order by its ID                   |
| GET    | `/api/admin/orders`        | List all orders (needs `X-Admin-Key` header)  |
| PATCH  | `/api/admin/orders/:id`    | Update an order's status (needs admin key)    |
| DELETE | `/api/admin/orders/:id`    | Delete an order (needs admin key)             |

## A note on WhatsApp

The floating WhatsApp button and the footer link still open a chat with
a pre-filled message — that's just a `wa.me` link, always free and needs
no setup. The **automatic order alert to Grandma's phone** is the part
that needs the Cloud API setup in step 8 above.

