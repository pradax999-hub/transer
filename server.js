const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');

// Node 22 loads local configuration; hosting environment variables take precedence.
if (fs.existsSync(path.join(__dirname, '.env'))) {
  if (typeof process.loadEnvFile !== 'function') throw new Error('Use Node.js 22 or newer to load .env.');
  process.loadEnvFile(path.join(__dirname, '.env'));
}

const app = express();
const PORT = process.env.PORT || 3000;
const configured = value => typeof value === 'string' && value.trim().length > 0 && !/placeholder|your[-_]|example\.com|change[-_]me/i.test(value);
const PUBLIC_URL = new URL(process.env.CLIENT_URL || `http://localhost:${PORT}`);
const ADMIN_TOKEN = process.env.DRIVER_ADMIN_TOKEN || '';
const PRIVATE_DATA_PATH = '/wry-ops-8f3c9a71d6e24b50';
if (!['https:', 'http:'].includes(PUBLIC_URL.protocol) || (PUBLIC_URL.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(PUBLIC_URL.hostname))) {
  throw new Error('CLIENT_URL must be HTTPS, except for localhost development.');
}
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Math.max(0, Math.min(3, Number(process.env.TRUST_PROXY_HOPS) || 0)));
const tokenHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const bearer = req => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
function matchesToken(token, hash) {
  if (!token || !hash || typeof hash !== 'string' || hash.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(hash, 'hex'));
}
function requireOperator(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (!configured(ADMIN_TOKEN) || ADMIN_TOKEN.length < 32) return res.status(503).json({ error: 'Operator access is not configured.' });
  if (!matchesToken(bearer(req), tokenHash(ADMIN_TOKEN))) return res.status(401).json({ error: 'Operator access denied.' });
  next();
}
function canReadOrder(req, order) {
  return order && matchesToken(bearer(req), order.accessHash);
}
function validCoordinate(value, max) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max; }
function safePoint(p) {
  return p && validCoordinate(p.lat, 90) && validCoordinate(p.lng, 180);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&#38;', '<': '&#60;', '>': '&#62;', '"': '&#34;', "'": '&#39;' }[char]));
}
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ============ Email Transporter ============
let transporter = null;
if (configured(process.env.EMAIL_USER) && configured(process.env.EMAIL_PASS)) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
    requireTLS: process.env.EMAIL_SECURE !== 'true',
    connectionTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
  console.log('✓ Email configured:', process.env.EMAIL_USER);
} else {
  console.log('⚠ Email not configured – set EMAIL_USER and EMAIL_PASS in .env');
}

// ============ Stripe ============
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
let stripe = null;
if (configured(STRIPE_KEY)) {
  try {
    stripe = require('stripe')(STRIPE_KEY);
    console.log('✓ Stripe gateway initialized');
  } catch (err) {
    console.warn('! Stripe init error:', err.message);
  }
}

app.use(cors({ origin: PUBLIC_URL.origin, allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'] }));
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== PUBLIC_URL.origin) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  next();
});

const REQUEST_WINDOWS = new Map();
app.use('/api', (req, res, next) => {
  if (req.path === '/webhook') return next();
  const bucket = req.path.startsWith('/operator') || req.path === '/test-email' ? 'operator' : req.path === '/checkout' ? 'checkout' : 'general';
  const key = `${req.ip}:${bucket}`, now = Date.now();
  let entry = REQUEST_WINDOWS.get(key);
  if (!entry || entry.until < now) {
    if (REQUEST_WINDOWS.size >= 10000) REQUEST_WINDOWS.clear();
    entry = { count: 0, until: now + 60000 }; REQUEST_WINDOWS.set(key, entry);
  }
  const limit = bucket === 'checkout' ? 8 : bucket === 'operator' ? 15 : 180;
  if (++entry.count > limit) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'Too many requests. Try again in a minute.' }); }
  next();
});

// Webhook для Stripe (сире тіло — для верифікації підпису)
// Підключається ПОСІЛ деплою: Stripe Dashboard → Developers → Webhooks → Add endpoint
// URL: https://ВАШ-ДОМЕН/api/webhook (інструкція на /webhook-setup)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (stripe && configured(webhookSecret)) {
    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object;
        const order = ORDERS.get(session.client_reference_id);
        if (order && session.payment_status === 'paid' && session.currency === 'czk' && session.amount_total === Math.round(order.amount * 100) && (!order.stripeSessionId || order.stripeSessionId === session.id) && order.paymentStatus !== 'succeeded') {
          order.paymentStatus = 'succeeded';
          order.stripeSessionId = session.id;
          order.paidAt = new Date().toISOString();
          if (order.email) {
            try { await sendEmail(order.email, 'Платіж підтверджено', paymentSuccessTemplate(order)); }
            catch (e) { console.warn('Post-payment email failed:', e.message); }
          }
        }
        if (order) persistData();
        console.log(`✓ Payment confirmed via webhook: ${session.client_reference_id}`);
      }
      return res.json({ received: true });
    } catch (err) {
      console.error('Webhook verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
  res.status(503).json({ received: false, error: 'Webhook is not configured yet.' });
});

// Простий ping, щоб перевірити, що вебхук-енпоінт живий після деплою
app.get('/api/webhook/ping', (req, res) => res.json({
  ok: true,
  stripe: Boolean(stripe),
  webhookSecretSet: Boolean(process.env.STRIPE_WEBHOOK_SECRET && !process.env.STRIPE_WEBHOOK_SECRET.includes('placeholder')),
  emailConfigured: Boolean(transporter)
}));

// JSON body parser must come AFTER the raw Stripe webhook route.
app.use(express.json({ limit: '24kb' }));

// Friendly setup URL that works after deployment without adding a web server rule.
app.get('/webhook-setup', (req, res) => {
  res.redirect('/#/nastaveni');
});

// Never expose order data, source files, .env or the former fake payment form.
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/driver', (req, res) => res.redirect('/#/ridic'));
app.get('/dispatch', (req, res) => res.redirect('/#/dispecink'));
app.get(PRIVATE_DATA_PATH, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.redirect('/#' + PRIVATE_DATA_PATH);
});
app.get(['/inter.woff2', '/instrument-serif-italic.woff2'], (req, res) => {
  res.sendFile(path.join(__dirname, path.basename(req.path)));
});

// ============ Тарифи Wayro ============
const FLEET_TARIFFS = {
  sedan:   { base: 850,  rate: 34, hour: 690,  city: 390 },
  minibus: { base: 1250, rate: 43, hour: 890,  city: 590 },
  mercE:   { base: 1290, rate: 55, hour: 1190, city: 790 },
  mercV:   { base: 1790, rate: 65, hour: 1490, city: 990 }
};

const PLACES = [
  { n: 'Letiště Praha (PRG)', g: 'prg', km: 17, lat: 50.1023, lng: 14.2637 },
  { n: 'Praha – centrum', g: 'prg-city', km: 0, lat: 50.0875, lng: 14.4213 },
  { n: 'Praha – Hlavní nádraží', g: 'prg-city', km: 2, lat: 50.0831, lng: 14.4360 },
  { n: 'Praha – Smíchov', g: 'prg-city', km: 4, lat: 50.0750, lng: 14.4060 },
  { n: 'Praha – Karlín', g: 'prg-city', km: 4, lat: 50.0900, lng: 14.4450 },
  { n: 'Praha – Dejvice', g: 'prg-city', km: 6, lat: 50.1065, lng: 14.3860 },
  { n: 'Praha – Chodov', g: 'prg-city', km: 11, lat: 50.0340, lng: 14.4980 },
  { n: 'Kladno', g: 'cz', km: 30, lat: 50.1461, lng: 14.1067 },
  { n: 'Karlovy Vary', g: 'cz', km: 130, lat: 50.2326, lng: 12.8714 },
  { n: 'Špindlerův Mlýn', g: 'cz', km: 150, lat: 50.7525, lng: 15.4080 },
  { n: 'Český Krumlov', g: 'cz', km: 175, lat: 48.8127, lng: 14.3175 },
  { n: 'Brno', g: 'cz', km: 205, lat: 49.1951, lng: 16.6068 },
  { n: 'Drážďany / Dresden', g: 'eu', km: 150, lat: 51.0504, lng: 13.7373 },
  { n: 'Bratislava', g: 'eu', km: 330, lat: 48.1486, lng: 17.1077 },
  { n: 'Vídeň / Vienna', g: 'eu', km: 335, lat: 48.2082, lng: 16.3738 },
  { n: 'Berlín / Berlin', g: 'eu', km: 350, lat: 52.5200, lng: 13.4050 },
  { n: 'Mnichov / Munich', g: 'eu', km: 385, lat: 48.1351, lng: 11.5820 }
];

const MEETS = {
  t1: { t: 'Terminál 1', s: 'Mattoni Bar', lat: 50.1028, lng: 14.2580 },
  t2: { t: 'Terminál 2', s: 'Visitor Centre', lat: 50.1069, lng: 14.2647 },
  hn: { t: 'Praha Hlavní nádraží', s: 'Burger King', lat: 50.0831, lng: 14.4360 }
};

const ORDERS = new Map();
const DRIVER_POSITIONS = new Map();

// Просте файлове сховище: рестарт сервера не втрачає бронювання
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(__dirname, 'data.json');
function persistData() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ orders: [...ORDERS.values()] }), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (d.orders || []).forEach(o => ORDERS.set(o.orderId || o.id, o));
    // GPS is ephemeral: after restart the driver must send a fresh measurement.
    if (ORDERS.size) console.log(`✓ Loaded ${ORDERS.size} orders from disk`);
  } catch (e) {
    throw new Error('Could not read order storage. Restore the file before starting the server.');
  }
}
loadData();

const place = name => PLACES.find(p => p.n.toLowerCase() === String(name || '').trim().toLowerCase());

// ============ Розрахунок ціни ============
// ============ Geocoding + routing (реальна відстань) ============
const UA = 'WayroTransfer/3.0';
const GEO_CACHE = new Map();
const ROUTE_CACHE = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 12;

function shortLabel(x) {
  const a = x.address || {};
  const street = [a.road, a.house_number].filter(Boolean).join(' ');
  const head = x.name || street || a.suburb || a.neighbourhood || '';
  const city = a.city || a.town || a.village || a.municipality || a.state || '';
  const parts = [head, city].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
  return parts.length ? parts.join(', ') : x.display_name.split(',').slice(0, 2).join(',').trim();
}

// Geoapify: autocomplete for addresses + Places API for named POIs (hotels like "diplomat").
// Key is read from the environment on every call, never hardcoded in the repo.
function geoKey() { return process.env.GEOAPIFY_API_KEY || ''; }
function normPlace(p, fallbackKind) {
  if (!p || typeof p !== 'object') return null;
  const categories = p.categories || [p.category || ''];
  const label = p.name || p.address_line1 || p.formatted;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const city = p.city || p.town || p.village || p.suburb;
  const address = [street, city, p.postcode].filter(Boolean).join(', ') || p.address_line2 || p.formatted || '';
  const out = {
    id: p.place_id || `${p.lat},${p.lon}`,
    label, address,
    full: p.formatted || [label, address].filter(Boolean).join(', '),
    lat: p.lat, lng: p.lon,
    kind: fallbackKind || (categories.some(c => String(c).startsWith('accommodation')) || /hotel|diplomat|hilton|marriott|motel|hostel/i.test(String(label || '')) ? 'hotel' : 'address'),
    source: 'geoapify'
  };
  if (Number.isFinite(p.distance)) out.distanceKm = Math.round((p.distance / 1000) * 10) / 10;
  return (typeof out.label === 'string' && out.label.trim() && safePoint(out)) ? out : null;
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8500) });
  if (!r.ok) throw new Error('places_unavailable');
  return r.json();
}
async function geocode(query, options = {}) {
  const text = String(query || '').trim();
  if (text.length < 2 || text.length > 160) return [];
  const key = geoKey();
  if (!configured(key)) throw new Error('places_not_configured');
  const lang = options.lang === 'en' ? 'en' : 'cs';
  const lat = validCoordinate(options.lat, 90) ? options.lat : 50.0875;
  const lng = validCoordinate(options.lng, 180) ? options.lng : 14.4213;
  const cacheKey = [text.toLowerCase(), lang, lat.toFixed(3), lng.toFixed(3)].join('|');
  const hit = GEO_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < 600000) return hit.results;
  const genericHotels = /^(hotels?|hotely|отел[ьи]|готел[іь])(?:\s+(praha|prague))?$/i.test(text);

  // 1) Address autocomplete (streets, stations, house numbers)
  const acUrl = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  acUrl.searchParams.set('apiKey', key);
  acUrl.searchParams.set('text', text);
  acUrl.searchParams.set('format', 'json');
  acUrl.searchParams.set('lang', lang);
  acUrl.searchParams.set('limit', '6');
  acUrl.searchParams.set('filter', 'countrycode:cz,de,at,sk,pl,hu');
  acUrl.searchParams.set('bias', `proximity:${lng},${lat}`);

  // 2) Places by name (hotels / venues like "diplomat") — same v2/places API family as your snippet,
  // but biased to Prague and filtered to stay-inside transfer area instead of a fixed supermarket rect.
  const plUrl = new URL('https://api.geoapify.com/v2/places');
  plUrl.searchParams.set('apiKey', key);
  plUrl.searchParams.set('lang', lang);
  plUrl.searchParams.set('limit', '7');
  plUrl.searchParams.set('bias', `proximity:${lng},${lat}`);
  plUrl.searchParams.set('filter', `circle:${lng},${lat},50000`);
  if (genericHotels) {
    plUrl.searchParams.set('categories', 'accommodation.hotel');
  } else {
    plUrl.searchParams.set('categories', 'accommodation,building.accommodation,commercial,catering,entertainment,tourism,public_transport');
    plUrl.searchParams.set('name', text);
  }

  const [acSettled, plSettled] = await Promise.allSettled([fetchJson(acUrl), fetchJson(plUrl)]);
  const acItems = acSettled.status === 'fulfilled' ? (acSettled.value.results || []) : [];
  const plItems = plSettled.status === 'fulfilled' ? (plSettled.value.features || []).map(f => f.properties) : [];
  if (acSettled.status !== 'fulfilled' && plSettled.status !== 'fulfilled') throw new Error('places_unavailable');

  // Places with an explicit name match go first (e.g. "diplomat" -> OREA Hotel Diplomat Prague).
  const seen = new Set();
  const results = [];
  const push = (p, kind) => {
    const n = normPlace(p, kind);
    if (!n) return;
    const dedupe = `${n.label.toLowerCase()}|${n.lat.toFixed(4)},${n.lng.toFixed(4)}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    results.push(n);
  };
  plItems.forEach(p => push(p, null));
  acItems.forEach(p => push(p, null));

  const out = results.slice(0, 7);
  if (GEO_CACHE.size >= 800) GEO_CACHE.delete(GEO_CACHE.keys().next().value);
  GEO_CACHE.set(cacheKey, { at: Date.now(), results: out });
  return out;
}

// Реальний маршрут по дорогах (OSRM)
async function roadRoute(a, b) {
  const key = `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
  const hit = ROUTE_CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit;

  const endpoint = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
  const url = `${endpoint}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('router unavailable');
  const d = await r.json();
  const route = d.routes && d.routes[0];
  if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration) || route.distance < 10) throw new Error('no route found');

  const out = { at: Date.now(), km: route.distance / 1000, min: route.duration / 60 };
  if (ROUTE_CACHE.size >= 800) ROUTE_CACHE.delete(ROUTE_CACHE.keys().next().value);
  ROUTE_CACHE.set(key, out);
  return out;
}

const textValue = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function locationSnapshot(point, entered = '') {
  const p = point && typeof point === 'object' ? point : {};
  const label = textValue(p.label, 160) || textValue(entered, 160);
  let address = textValue(p.address, 500);
  const originalFull = textValue(p.full, 700);
  if (!address && originalFull && originalFull.toLowerCase() !== label.toLowerCase()) {
    address = originalFull.toLowerCase().startsWith(label.toLowerCase()) ? originalFull.slice(label.length).replace(/^[,;\s]+/, '') : originalFull;
  }
  if (address.toLowerCase() === label.toLowerCase()) address = '';
  const full = originalFull && originalFull.toLowerCase().includes(label.toLowerCase()) ? originalFull : [label, address].filter(Boolean).join(', ');
  return {
    label, address, full: full || textValue(entered, 700),
    id: textValue(p.id, 400), kind: textValue(p.kind, 40) || 'address',
    lat: safePoint(p) ? p.lat : null, lng: safePoint(p) ? p.lng : null
  };
}
function compatibleLocation(point, entered) {
  return point && (!entered || textValue(point.label).toLowerCase() === textValue(entered).toLowerCase() || textValue(point.full).toLowerCase() === textValue(entered).toLowerCase()) ? point : null;
}
function orderLocations(order) {
  const b = order.booking || {};
  const saved = order.locations || b.locations || {};
  const get = (key, field) => saved[key]?.label
    ? locationSnapshot(saved[key], saved[key].label)
    : locationSnapshot(compatibleLocation(b[field + 'Geo'], b[field]), b[field]);
  return {
    pickup: get('pickup', 'from'),
    destination: b.mode === 'hourly' ? null : get('destination', 'to'),
    stopover: saved.stopover?.label || b.stopover ? get('stopover', 'stopover') : null
  };
}
const locationText = p => p ? p.full || [p.label, p.address].filter(Boolean).join(', ') : '';

// Keep the selected place and its full address independent of the trip category.
async function resolvePoint(input) {
  if (safePoint(input)) {
    return locationSnapshot(input, input.label);
  }
  const name = typeof input === 'string' ? input : (input && input.label) || '';
  const known = place(name);
  if (known) return { label: known.n, address: known.n, full: known.n, lat: known.lat, lng: known.lng, known: true, group: known.g };
  // Never silently book the first result for an ambiguous hotel name.
  return null;
}

const nearKm = (a, b) => Math.hypot((a.lat - b.lat) * 111.32, (a.lng - b.lng) * 111.32 * Math.cos(a.lat * Math.PI / 180));
const isAirport = p => safePoint(p) && nearKm(p, PLACES[0]) < 1.8;
const isPragueCity = p => safePoint(p) && !isAirport(p) && nearKm(p, PLACES[1]) < 6;

// Ціна для одного класу авто
function priceForCar(carKey, ctx) {
  const car = FLEET_TARIFFS[carKey] || FLEET_TARIFFS.sedan;

  if (ctx.mode === 'hourly') {
    const hours = Math.max(2, parseInt(ctx.hours, 10) || 2);
    return { base: car.hour * hours, kind: 'hourly' };
  }
  // Фіксований тариф аеропорт ↔ Прага
  if (ctx.fixedAirport) return { base: car.base, kind: 'fixed' };
  // Реальні кілометри → лічильник за тарифом
  if (Number.isFinite(ctx.km) && ctx.km > 0) {
    const metered = Math.round((ctx.km * car.rate) / 10) * 10;
    return { base: Math.max(car.city, metered), kind: 'metered' };
  }
  return { base: car.base, kind: 'unknown' };
}

function applyExtras(base, booking) {
  const returnMultiplier = booking.roundtrip && booking.mode !== 'hourly' ? 2 : 1;
  const subtotal = base * returnMultiplier;
  let discount = 0;
  const promo = String(booking.promo || '').toUpperCase();
  if (promo === 'WAYRO10' || promo.startsWith('WY-')) discount = Math.round(subtotal * 0.10);
  else if (promo === 'PRG15') discount = Math.round(subtotal * 0.15);
  return { base, subtotal, discount, total: Math.max(0, subtotal - discount), currency: 'CZK' };
}

// ============ Email Templates ============
function bookingConfirmationTemplate(order) {
  const b = order.booking || {}, points = orderLocations(order);
  const en = b.language === 'en', tr = (cs, english) => en ? english : cs;
  const cars = { sedan: 'Sedan Standard', minibus: 'Minivan Standard', mercE: 'Business Sedan', mercV: 'Business Minivan' };
  const rows = [
    [tr('Rezervace', 'Booking'), order.orderId || order.id],
    [tr('Vyzvednutí', 'Pickup'), locationText(points.pickup)],
    [tr('Cíl', 'Destination'), points.destination ? locationText(points.destination) : tr('Hodinová dispozice', 'Hourly hire') + ` (${b.hours} h)`],
    ...(points.stopover ? [[tr('Zastávka', 'Stopover'), locationText(points.stopover)]] : []),
    [tr('Datum a čas', 'Date and time'), `${b.date} ${b.time} (Europe/Prague)`],
    ...(b.roundtrip ? [[tr('Zpáteční jízda', 'Return ride'), `${b.retDate} ${b.retTime}: ${locationText(points.destination)} -> ${locationText(points.pickup)}`]] : []),
    [tr('Vůz', 'Vehicle'), cars[b.car] || b.car],
    [tr('Počet osob', 'Passengers'), b.pax],
    ...(Number.isFinite(b.distanceKm) ? [[tr('Trasa po silnici', 'Road route'), `${b.distanceKm} km${Number.isFinite(b.durationMin) ? ` / ${b.durationMin} min` : ''}`]] : []),
    [tr('Zavazadla / dětské sedačky', 'Large bags / cabin bags / child seats'), `${b.bagsBig || 0} / ${b.bagsSmall || 0} / ${b.seats || 0}`],
    ...(b.flight ? [[tr('Let', 'Flight'), b.flight]] : []),
    [tr('Kontakt', 'Contact'), [b.name, b.phone, b.email].filter(Boolean).join(' / ')],
    [tr('Platba', 'Payment'), b.pay === 'online' ? tr('Online, stav ověřuje Stripe', 'Online, verified by Stripe') : b.pay === 'card' ? tr('Kartou u řidiče', 'Card to driver') : tr('Hotově u řidiče', 'Cash to driver')],
    [tr('Cena', 'Price'), `${order.amount} ${order.currency}`],
    ...(b.notes ? [[tr('Poznámka', 'Note'), b.notes]] : [])
  ];
  return `<!DOCTYPE html><html lang="${en ? 'en' : 'cs'}"><head><meta charset="UTF-8"></head><body style="margin:0;padding:24px;background:#0d0c08;color:#eee7d8;font-family:Arial,sans-serif"><div style="max-width:620px;margin:auto;padding:28px;border:1px solid #3b3320">
    <h1 style="color:#f5c66b;font-size:24px">Wayro / ${tr('Přijali jsme žádost', 'Request received')}</h1>
    <p style="font-size:14px;line-height:1.7;color:#b9b0a0">${tr('Přijetí žádosti ani platba ještě nepotvrzují přidělení vozu. Vyčkejte na odpověď dispečinku.', 'Receiving a request or payment does not confirm a vehicle assignment. Please await dispatch confirmation.')}</p>
    <table role="presentation" style="width:100%;border-collapse:collapse">${rows.map(([label, value]) => `<tr><td style="padding:12px 12px 12px 0;border-bottom:1px solid #342e20;color:#b9b0a0;vertical-align:top;font-size:12px;width:32%">${escapeHtml(label)}</td><td style="padding:12px 0;border-bottom:1px solid #342e20;font-size:14px;line-height:1.6;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`).join('')}</table>
    <p style="font-size:12px;color:#b9b0a0;line-height:1.7">${tr('Trasu uchováváme přesně podle zvolených míst v žádosti.', 'The itinerary preserves the exact locations chosen in your request.')}</p>
    </div></body></html>`;
}

function driverAssignedTemplate(order, driverName) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body{font-family:system-ui,sans-serif;background:#0d0c08;color:#e9e2d2;padding:24px}
  .card{max-width:520px;margin:0 auto;background:#141209;border:1px solid #2c2819;border-radius:12px;padding:28px}
  h1{color:#f5c66b;font-size:22px;margin:0 0 18px}
  .driver{background:#1a1710;border-radius:8px;padding:16px;margin:16px 0}
  .driver-name{font-size:18px;font-weight:600;color:#f5c66b}
  .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #262319}
  .footer{margin-top:24px;font-size:11px;color:#6b6558;text-align:center}
</style></head>
<body>
  <div class="card">
    <h1>✅ Водій призначений</h1>
    <p style="color:#9c9585;font-size:13px;line-height:1.6">
      Ваш водій підтвердив замовлення і буде на місці вчасно.
    </p>
    
    <div class="driver">
      <div class="driver-name">👤 ${driverName || 'Водій Wayro'}</div>
      <div style="color:#8a8474;font-size:12px;margin-top:6px">
        Слідкуйте за автомобілем у реальному часі через додаток або веб-сайт.
      </div>
    </div>
    
    <div class="row"><span class="label">Номер замовлення</span><span>${order.id}</span></div>
    <div class="row"><span class="label">Час подачі</span><span>${order.booking.date} ${order.booking.time}</span></div>
    
    <div class="footer">Wayro Transfer · Prague Airport</div>
  </div>
</body>
</html>`;
}

function paymentSuccessTemplate(order) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body{font-family:system-ui,sans-serif;background:#0d0c08;color:#e9e2d2;padding:24px}
  .card{max-width:520px;margin:0 auto;background:#141209;border:1px solid #2c2819;border-radius:12px;padding:28px}
  h1{color:#4ade80;font-size:22px;margin:0 0 18px}
  .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #262319}
  .total{font-size:24px;color:#4ade80;font-weight:700}
  .footer{margin-top:24px;font-size:11px;color:#6b6558;text-align:center}
</style></head>
<body>
  <div class="card">
    <h1>✅ Платіж підтверджено</h1>
    <p style="color:#9c9585;font-size:13px;line-height:1.6;margin-bottom:20px">
      Ваша оплата успішно пройшла. Замовлення повністю підтверджене.
    </p>
    
    <div class="row"><span class="label">Номер замовлення</span><span>${order.id}</span></div>
    <div class="row"><span class="label">Сума</span><span class="total">${order.amount} ${order.currency}</span></div>
    <div class="row"><span class="label">Дата оплати</span><span>${new Date(order.paidAt).toLocaleString('uk-UA')}</span></div>
    
    <div class="footer">Wayro Transfer · Prague Airport</div>
  </div>
</body>
</html>`;
}

async function sendEmail(to, subject, html) {
  if (!transporter) {
    return { sent: false, status: 'not_configured' };
  }
  
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to,
      subject,
      html
    });
    console.log(`📧 Email sent to ${to}: ${subject} (${info.messageId})`);
    return { ...info, sent: Array.isArray(info.accepted) && info.accepted.length > 0, status: info.accepted?.length ? 'accepted' : 'rejected' };
  } catch (err) {
    console.error('Email error:', err.message);
    throw err;
  }
}

// ============ API Endpoints ============

// Підказки адрес: вокзал, готель, вулиця з номером — будь-що
app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3 || q.length > 160) return res.json({ results: [], provider: null });

  const local = PLACES
    .filter(p => p.n.toLowerCase().includes(q.toLowerCase()))
    .map(p => ({ label: p.n, full: p.n, address: p.n, lat: p.lat, lng: p.lng, known: true, source: 'wayro', kind: 'address' }));

  try {
    const remote = await geocode(q, { lang: req.query.lang, lat: req.query.lat ? Number(req.query.lat) : undefined, lng: req.query.lng ? Number(req.query.lng) : undefined });
    const seen = new Set(local.map(x => x.label.toLowerCase()));
    const merged = [...local, ...remote.filter(x => !seen.has(x.label.toLowerCase()))].slice(0, 7);
    res.json({ results: merged, provider: 'geoapify' });
  } catch (err) {
    res.status(503).json({ results: local, code: err.message === 'places_not_configured' ? 'places_not_configured' : 'places_unavailable', provider: null });
  }
});

const QUOTES = new Map();
const CHECKOUT_REQUESTS = new Map();
function bookingPoint(booking, name) {
  const selected = booking[name + 'Geo'];
  return selected && selected.label === booking[name] ? selected : booking[name];
}
function routeFingerprint(booking) {
  const keyPoint = input => typeof input === 'string' ? input.trim().toLowerCase() : safePoint(input) ? [input.label, input.address || '', input.full || '', input.lat, input.lng] : null;
  return JSON.stringify([booking.mode, keyPoint(bookingPoint(booking, 'from')), keyPoint(bookingPoint(booking, 'to')), String(booking.stopover || '').trim(), keyPoint(booking.stopoverGeo), Number(booking.hours) || 0, !!booking.roundtrip, String(booking.promo || '').toUpperCase()]);
}
const bounded = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
function pragueTimestamp(date, time) {
  const sample = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(sample.getTime()) || sample.toISOString().slice(0, 10) !== date) return NaN;
  const zone = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Prague', timeZoneName: 'longOffset' }).formatToParts(sample).find(p => p.type === 'timeZoneName').value.replace('GMT', '');
  const instant = new Date(`${date}T${time}:00${zone}`);
  if (!Number.isFinite(instant.getTime())) return NaN;
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
  return local === time ? instant.getTime() : NaN;
}
function bookingError(b) {
  const caps = { sedan: [4, 3, 1], minibus: [7, 7, 3], mercE: [3, 2, 0], mercV: [7, 7, 2] };
  if (!b || !Object.hasOwn(caps, b.car) || !['from', 'to', 'long', 'hourly'].includes(b.mode)) return 'Invalid vehicle or trip type.';
  if (!bounded(b.pax, 1, caps[b.car][0]) || !bounded(b.seats, 0, Math.min(b.pax, caps[b.car][2])) || !bounded(b.bagsBig, 0, caps[b.car][1]) || !bounded(b.bagsSmall, 0, 4)) return 'Vehicle capacity exceeded.';
  if (b.bagsBig * 2 + b.bagsSmall + (b.pram ? 2 : 0) > caps[b.car][1] * 2 + 2) return 'Luggage capacity exceeded.';
  if (typeof b.name !== 'string' || b.name.trim().length < 2 || b.name.length > 60 || typeof b.email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(b.email) || b.email.length > 120 || !/^[+\d ()-]{9,25}$/.test(String(b.phone || ''))) return 'Please check the contact details.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !/^\d{2}:\d{2}$/.test(b.time || '') || !['cash', 'card', 'online'].includes(b.pay) || b.consent !== true) return 'Invalid booking details.';
  const pickup = pragueTimestamp(b.date, b.time);
  if (!Number.isFinite(pickup) || pickup < Date.now() + 30 * 60000) return 'Choose pickup at least 30 minutes ahead in Prague time.';
  if (b.roundtrip) {
    const back = pragueTimestamp(b.retDate, b.retTime);
    if (!Number.isFinite(back) || back < pickup + 2 * 3600000) return 'Return pickup must be at least 2 hours later.';
  }
  if ([b.from, b.to, b.stopover || '', b.notes || '', b.sign || ''].some(v => typeof v !== 'string' || v.length > 500)) return 'Invalid address or note.';
  return '';
}

// Quotes bind selected coordinates to a server-computed price for 15 minutes.
app.post('/api/quote', async (req, res) => {
  try {
    const booking = req.body.booking || {};
    if (!['from', 'to', 'long', 'hourly'].includes(booking.mode)) return res.status(400).json({ ok: false, reason: 'invalid_mode' });
    let from = null, to = null, via = null, km = null, min = null, fixedAirport = false;
    if (booking.mode === 'hourly') {
      if (!bounded(booking.hours, 2, 12)) return res.status(400).json({ ok: false, reason: 'invalid_hours' });
      from = await resolvePoint(bookingPoint(booking, 'from'));
      if (!from) return res.status(422).json({ ok: false, reason: 'select_address' });
    } else {
      [from, to] = await Promise.all([resolvePoint(bookingPoint(booking, 'from')), resolvePoint(bookingPoint(booking, 'to'))]);
      if (!from || !to) return res.status(422).json({ ok: false, reason: 'select_address' });
      if (nearKm(from, to) < .01) return res.status(422).json({ ok: false, reason: 'same_address' });
      fixedAirport = !booking.stopover && ((isAirport(from) && isPragueCity(to)) || (isAirport(to) && isPragueCity(from)));
      via = booking.stopover ? await resolvePoint(booking.stopoverGeo) : null;
      if (booking.stopover && (!via || via.label !== booking.stopover)) return res.status(422).json({ ok: false, reason: 'select_stopover' });
      const legs = via ? [await roadRoute(from, via), await roadRoute(via, to)] : [await roadRoute(from, to)];
      km = legs.reduce((sum, leg) => sum + leg.km, 0);
      min = legs.reduce((sum, leg) => sum + leg.min, 0);
    }

    const prices = {};
    for (const key of Object.keys(FLEET_TARIFFS)) {
      const p = priceForCar(key, { mode: booking.mode, hours: booking.hours, fixedAirport, km });
      prices[key] = { ...applyExtras(p.base, booking), kind: p.kind };
    }

    const quoteId = newToken();
    const quote = {
      ok: true,
      quoteId,
      kind: booking.mode === 'hourly' ? 'hourly' : fixedAirport ? 'fixed' : 'metered',
      from, to, stopover: via,
      km: km ? Math.round(km * 10) / 10 : null,
      min: min ? Math.max(1, Math.round(min)) : null,
      routeSource: km ? 'osrm' : null,
      expiresAt: Date.now() + 15 * 60000,
      prices
    };
    if (QUOTES.size >= 1000) QUOTES.delete(QUOTES.keys().next().value);
    QUOTES.set(quoteId, { ...quote, fingerprint: routeFingerprint(booking) });
    res.json(quote);
  } catch (err) {
    console.error('Quote error:', err.message);
    res.status(503).json({ ok: false, reason: 'routing_unavailable' });
  }
});

// Створення замовлення + email
app.post('/api/checkout', async (req, res) => {
  try {
    const { booking, quoteId, expectedTotal } = req.body;
    const invalid = bookingError(booking);
    if (invalid) return res.status(400).json({ error: invalid });
    const quote = QUOTES.get(quoteId);
    if (!quote || quote.expiresAt < Date.now() || quote.fingerprint !== routeFingerprint(booking)) return res.status(409).json({ error: 'Quote expired. Please calculate the route again.' });
    const price = quote.prices[booking.car];
    if (!price || expectedTotal !== price.total) return res.status(409).json({ error: 'Price changed. Review the quote before paying.' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!/^[a-z0-9-]{20,80}$/i.test(idempotencyKey)) return res.status(400).json({ error: 'An idempotency key is required.' });
    const previous = CHECKOUT_REQUESTS.get(idempotencyKey);
    if (previous) return res.status(409).json({ error: 'This request has already been received. Check your booking before submitting again.' });
    const wantsOnlinePayment = booking.pay === 'online';
    if (wantsOnlinePayment && !stripe) return res.status(503).json({ error: 'Online payment is not configured. Choose payment to the driver.' });
    const orderId = `WY-${crypto.randomUUID().toUpperCase()}`;
    const accessToken = newToken();
    const locations = {
      pickup: locationSnapshot(quote.from, booking.from),
      destination: booking.mode === 'hourly' ? null : locationSnapshot(quote.to, booking.to),
      stopover: quote.stopover ? locationSnapshot(quote.stopover, booking.stopover) : null
    };
    const order = {
      id: orderId, orderId,
      locations,
      booking: { ...booking, from: locations.pickup.label, to: locations.destination?.label || '', stopover: locations.stopover?.label || '', distanceKm: quote.km, durationMin: quote.min, fromGeo: locations.pickup, toGeo: locations.destination, stopoverGeo: locations.stopover },
      accessHash: tokenHash(accessToken),
      stage: 0,
      amount: price.total,
      currency: price.currency,
      paymentStatus: wantsOnlinePayment ? 'pending' : 'pay_on_arrival',
      email: booking.email,
      name: booking.name,
      createdAt: new Date().toISOString(),
      emailStatus: 'not_configured',
      testPayment: wantsOnlinePayment && STRIPE_KEY.startsWith('sk_test_')
    };
    CHECKOUT_REQUESTS.set(idempotencyKey, orderId);
    if (CHECKOUT_REQUESTS.size > 2000) CHECKOUT_REQUESTS.delete(CHECKOUT_REQUESTS.keys().next().value);
    ORDERS.set(orderId, order);
    persistData();

    // Відправка email підтвердження
    if (order.email) {
      try {
        const result = await sendEmail(order.email, `Wayro / ${orderId}`, bookingConfirmationTemplate(order));
        order.emailStatus = result.status;
        if (configured(process.env.DISPATCH_EMAIL)) {
          await sendEmail(process.env.DISPATCH_EMAIL, `Wayro / new request ${orderId}`, bookingConfirmationTemplate(order));
        }
      } catch (e) {
        if (order.emailStatus !== 'accepted') order.emailStatus = 'failed';
        console.warn('Email failed, continuing anyway:', e.message);
      }
    }
    persistData();

    if (!wantsOnlinePayment) {
      return res.json({
        orderId,
        accessToken,
        locations: orderLocations(order),
        distanceKm: quote.km,
        durationMin: quote.min,
        emailStatus: order.emailStatus,
        confirmationUrl: null,
        amount: { value: price.total, currency: 'CZK' },
        paymentStatus: 'pay_on_arrival'
      });
    }

    if (stripe) {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        client_reference_id: orderId,
        line_items: [{
          price_data: {
            currency: 'czk',
            product_data: {
              name: `Wayro: ${locationText(locations.pickup)} -> ${locationText(locations.destination) || 'Hourly hire'}`.slice(0, 250),
              description: `Vehicle: ${booking.car}, Pax: ${booking.pax || 1}`
            },
            unit_amount: Math.round(price.total * 100)
          },
          quantity: 1
        }],
        mode: 'payment',
        success_url: `${PUBLIC_URL.origin}/#/jizda/${encodeURIComponent(orderId)}?payment=return`,
        cancel_url: `${PUBLIC_URL.origin}/#/jizda/${encodeURIComponent(orderId)}?payment=cancelled`
      }, { idempotencyKey });

      order.stripeSessionId = session.id;
      persistData();

      return res.json({
        orderId,
        accessToken,
        locations: orderLocations(order),
        distanceKm: quote.km,
        durationMin: quote.min,
        emailStatus: order.emailStatus,
        testPayment: order.testPayment,
        confirmationUrl: session.url,
        amount: { value: price.total, currency: 'CZK' }
      });
    }

    return res.status(503).json({ error: 'Payment unavailable.' });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message || 'Payment processing failed' });
  }
});

// Перевірка статусу замовлення.
// Навіть без webhook'а статус сам оновлюється: запитуємо Stripe API напряму,
// тобто після деплою вебхук — додатковий захист, а не єдина можливість.
app.get('/api/order-status', async (req, res) => {
  const { orderId } = req.query;
  const order = ORDERS.get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canReadOrder(req, order)) return res.status(403).json({ error: 'Booking access required.' });

  if (order.paymentStatus === 'pending' && order.stripeSessionId && stripe) {
    try {
      const s = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
      if (s.payment_status === 'paid' && s.client_reference_id === orderId && s.amount_total === Math.round(order.amount * 100) && s.currency === 'czk') {
        order.paymentStatus = 'succeeded';
        order.paidAt = new Date().toISOString();
        if (order.email) {
          sendEmail(order.email, 'Платіж підтверджено', paymentSuccessTemplate(order)).catch(() => {});
        }
        console.log(`✓ Payment confirmed via API check: ${orderId}`);
      } else if (s.status === 'expired' || s.status === 'canceled') {
        order.paymentStatus = 'expired';
      }
      persistData();
    } catch (err) {
      console.warn('Stripe session check failed:', err.message);
    }
  }

  res.json({
    orderId,
    locations: orderLocations(order),
    distanceKm: order.booking.distanceKm ?? null,
    durationMin: order.booking.durationMin ?? null,
    stage: order.stage || 0,
    emailStatus: order.emailStatus,
    testPayment: !!order.testPayment,
    paymentStatus: order.paymentStatus,
    amount: { value: order.amount, currency: order.currency },
    paidAt: order.paidAt || null,
    timestamp: new Date().toISOString()
  });
});

function reservationView(order, detailed = false) {
  const b = order.booking || {};
  const base = {
    id: textValue(order.orderId || order.id, 80),
    locations: orderLocations(order),
    customerName: textValue(b.name || order.name, 80),
    date: textValue(b.date, 10), time: textValue(b.time, 5),
    car: textValue(b.car, 30), passengers: Number.isInteger(b.pax) ? b.pax : null,
    mode: textValue(b.mode, 20), hours: Number.isFinite(b.hours) ? b.hours : null,
    amount: Number.isFinite(order.amount) ? order.amount : null,
    currency: textValue(order.currency, 3) || 'CZK',
    stage: Number.isInteger(order.stage) && order.stage >= 0 && order.stage <= 6 ? order.stage : 0,
    cancelled: order.cancelled === true,
    paymentStatus: textValue(order.paymentStatus, 40) || 'unknown',
    emailStatus: textValue(order.emailStatus, 40) || 'unknown',
    createdAt: textValue(order.createdAt, 40),
    distanceKm: Number.isFinite(b.distanceKm) ? b.distanceKm : null,
    durationMin: Number.isFinite(b.durationMin) ? b.durationMin : null,
    testPayment: order.testPayment === true,
    roundtrip: b.roundtrip === true, returnDate: textValue(b.retDate, 10), returnTime: textValue(b.retTime, 5)
  };
  if (!detailed) return base;
  // Whitelist fields: never return access hashes, driver tokens, Stripe IDs or env.
  return {
    ...base,
    phone: textValue(b.phone, 30), email: textValue(b.email || order.email, 120),
    flight: textValue(b.flight, 12), meet: textValue(b.meet, 12), sign: textValue(b.sign, 80),
    bagsBig: Number.isInteger(b.bagsBig) ? b.bagsBig : null,
    bagsSmall: Number.isInteger(b.bagsSmall) ? b.bagsSmall : null,
    childSeats: Number.isInteger(b.seats) ? b.seats : null,
    seatType: textValue(b.seatType, 20), pram: b.pram === true,
    notes: textValue(b.notes, 500), promo: textValue(b.promo, 30),
    driverName: textValue(order.driverName, 80), driverPlate: textValue(order.driverPlate, 20),
    driverPhone: textValue(order.driverPhone, 30),
    paidAt: textValue(order.paidAt, 40)
  };
}
const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function validDateFilter(value) {
  if (value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
app.post('/api/operator/reservations/search', requireOperator, (req, res) => {
  const body = req.body || {};
  const q = searchText(textValue(body.query, 160));
  const state = textValue(body.state, 20) || 'all';
  const dateFrom = textValue(body.dateFrom, 20), dateTo = textValue(body.dateTo, 20);
  const page = Number(body.page || 1), pageSize = 15;
  if (!['all', 'pending', 'active', 'completed', 'cancelled'].includes(state) || !validDateFilter(dateFrom) || !validDateFilter(dateTo) || (dateFrom && dateTo && dateFrom > dateTo) || !Number.isInteger(page) || page < 1 || page > 100000) {
    return res.status(400).json({ error: 'Invalid filters.' });
  }
  const found = [...ORDERS.values()].filter(o => o && o.booking && typeof (o.orderId || o.id) === 'string').filter(o => {
    const b = o.booking, stage = Number.isInteger(o.stage) ? o.stage : 0;
    if (state === 'cancelled' && !o.cancelled) return false;
    if (state === 'pending' && (o.cancelled || stage >= 2)) return false;
    if (state === 'active' && (o.cancelled || stage < 2 || stage >= 6)) return false;
    if (state === 'completed' && (o.cancelled || stage !== 6)) return false;
    if ((dateFrom && String(b.date || '') < dateFrom) || (dateTo && String(b.date || '') > dateTo)) return false;
    if (q) {
      const points = orderLocations(o);
      const haystack = [o.orderId || o.id, b.name, b.phone, b.email, ...Object.values(points).map(locationText)].map(searchText).join(' ');
      if (!haystack.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || String(a.orderId).localeCompare(String(b.orderId)));
  const pages = Math.max(1, Math.ceil(found.length / pageSize));
  const currentPage = Math.min(page, pages);
  res.json({ items: found.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(o => reservationView(o)), total: found.length, page: currentPage, pages, pageSize });
});
app.get('/api/operator/reservations/:orderId', requireOperator, (req, res) => {
  const order = ORDERS.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ reservation: reservationView(order, true) });
});

// Отримати позицію водія
app.get('/api/driver/:orderId', (req, res) => {
  const order = ORDERS.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!canReadOrder(req, order)) return res.status(403).json({ error: 'Booking access required.' });
  const position = DRIVER_POSITIONS.get(order.orderId);
  const assigned = !!order.driverAccessHash && order.driverExpiresAt > Date.now() && !order.cancelled && order.stage !== 6;
  const fresh = assigned && position?.source === 'gps' && Date.now() - position.recordedAt < 60000;
  res.json({
    assigned, status: !assigned ? 'unassigned' : fresh ? 'live' : position ? 'stale' : 'waiting',
    lat: fresh ? position.lat : null, lng: fresh ? position.lng : null,
    accuracy: fresh ? position.accuracy : null,
    speedKmh: fresh ? position.speedKmh : null,
    updatedAt: position ? new Date(position.recordedAt).toISOString() : null,
    source: fresh ? 'gps' : null,
    driverName: assigned ? order.driverName || null : null,
    licensePlate: assigned ? order.driverPlate || null : null,
    phone: assigned ? order.driverPhone || null : null,
    whatsapp: assigned ? order.driverPhone || null : null
  });
});

function driverAccess(req, res, next) {
  const order = ORDERS.get(req.params.orderId);
  if (!order || !matchesToken(bearer(req), order.driverAccessHash)) return res.status(403).json({ error: 'Driver link is invalid or has been replaced.' });
  if (order.driverExpiresAt <= Date.now() || order.cancelled || order.stage === 6) return res.status(410).json({ error: 'Driver link has expired or the ride has ended.' });
  req.order = order;
  next();
}
app.post('/api/operator/driver-link', requireOperator, (req, res) => {
  const order = ORDERS.get(String(req.body.orderId || ''));
  if (!order || order.cancelled || order.stage === 6) return res.status(404).json({ error: 'Active booking not found.' });
  const token = newToken();
  order.driverAccessHash = tokenHash(token);
  order.driverExpiresAt = Date.now() + 12 * 3600000;
  order.driverStoppedAt = Date.now();
  order.driverName = String(req.body.name || '').trim().slice(0, 80);
  order.driverPlate = String(req.body.plate || '').trim().slice(0, 20);
  order.driverPhone = /^[+\d ()-]{8,25}$/.test(String(req.body.phone || '')) ? String(req.body.phone) : '';
  order.stage = Math.max(order.stage || 0, 2);
  DRIVER_POSITIONS.delete(order.orderId);
  persistData();
  const url = new URL(PUBLIC_URL.origin);
  url.hash = `/ridic?order=${encodeURIComponent(order.orderId)}&token=${token}`;
  res.json({ driverUrl: url.href, expiresAt: order.driverExpiresAt });
});
app.get('/api/driver-session/:orderId', driverAccess, (req, res) => {
  const locations = orderLocations(req.order);
  res.json({ orderId: req.order.orderId, from: locationText(locations.pickup), to: locationText(locations.destination), locations, expiresAt: req.order.driverExpiresAt });
});
app.post('/api/driver/:orderId', driverAccess, (req, res) => {
  const { orderId } = req.params;
  if (req.body.active === false) {
    req.order.driverStoppedAt = Date.now();
    DRIVER_POSITIONS.delete(orderId);
    return res.json({ ok: true, active: false });
  }
  const { lat, lng, accuracy, recordedAt, speedKmh } = req.body;
  if (!safePoint({ lat, lng }) || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 150 || !Number.isFinite(recordedAt) || Math.abs(Date.now() - recordedAt) > 60000) {
    return res.status(422).json({ error: 'A recent, accurate device location is required.' });
  }
  const previous = DRIVER_POSITIONS.get(orderId);
  if (recordedAt <= (req.order.driverStoppedAt || 0) || (previous && recordedAt <= previous.recordedAt)) return res.status(409).json({ error: 'An older position cannot replace a newer one.' });
  DRIVER_POSITIONS.set(orderId, {
    lat, lng, accuracy, recordedAt, source: 'gps',
    speedKmh: typeof speedKmh === 'number' && speedKmh >= 0 && speedKmh < 220 ? speedKmh : null
  });
  res.json({ ok: true, active: true, acceptedAt: new Date().toISOString() });
});

// Публічна конфігурація для фронтенду (тільки безпечні поля)
app.get('/api/config', (req, res) => {
  res.json({
    whatsapp: process.env.WHATSAPP || null,
    phone: process.env.PHONE || null,
    supportEmail: process.env.SUPPORT_EMAIL || null,
    flightProvider: process.env.FLIGHT_PROVIDER || null,
    emailConfigured: Boolean(transporter),
    stripe: Boolean(stripe),
    placesConfigured: configured(process.env.GEOAPIFY_API_KEY),
    placesProvider: configured(process.env.GEOAPIFY_API_KEY) ? 'geoapify' : null,
    driverConfigured: configured(ADMIN_TOKEN) && ADMIN_TOKEN.length >= 32,
    webhookConfigured: configured(process.env.STRIPE_WEBHOOK_SECRET),
    dispatchEmailConfigured: configured(process.env.DISPATCH_EMAIL),
    routingProductionConfigured: configured(process.env.OSRM_URL),
    storagePersistentVolumeRequired: true
  });
});

// Статус рейсу в реальному часі (потрібен FLIGHT_API_KEY у .env)
app.get('/api/flight', async (req, res) => {
  const fl = String(req.query.fl || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,3}\d{1,4}$/.test(fl)) {
    return res.json({ ok: false, reason: 'bad_format', message: 'Надішліть номер рейсу, напр. LH1400' });
  }
  const provider = (process.env.FLIGHT_PROVIDER || 'aviationstack').toLowerCase();
  const key = process.env.FLIGHT_API_KEY;
  if (!key || key.includes('placeholder')) {
    return res.json({ ok: false, reason: 'no_key', message: 'Flight data key is not configured on the server (FLIGHT_API_KEY)' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const date = req.query.date || today;
  try {
    if (provider === 'aviationstack') {
      const url = `https://api.aviationstack.io/v2/flights?access_key=${key}&flight_iata=${fl}&date=${date}`;
      const r = await fetch(url);
      const d = await r.json();
      const f = (d.data || [])[0];
      if (!f) return res.json({ ok: false, reason: 'not_found', message: `Рейс ${fl} не знайдений на ${date}` });
      const depSch = f.departure?.scheduled, depAct = f.departure?.actual || f.departure?.estimated;
      const arrSch = f.arrival?.scheduled, arrAct = f.arrival?.actual || f.arrival?.estimated;
      const delayMin = arrSch && arrAct ? Math.round((new Date(arrAct) - new Date(arrSch)) / 60000) : (depSch && depAct ? Math.round((new Date(depAct) - new Date(depSch)) / 60000) : 0);
      return res.json({
        ok: true, flight: fl, provider,
        status: f.status || 'unknown',
        delayMin,
        dep: depAct || depSch, arr: arrAct || arrSch,
        origin: f.departure?.airport?.name, destination: f.arrival?.airport?.name,
        waitingFree: delayMin > 0
      });
    }
    if (provider === 'flightsfrom') {
      const url = `https://api.flightsfrom.com/v1/search?token=${key}&flight=${fl}`;
      const r = await fetch(url);
      const d = await r.json();
      const f = (d.results || [])[0];
      if (!f) return res.json({ ok: false, reason: 'not_found', message: `Рейс ${fl} не знайдено` });
      return res.json({ ok: true, flight: fl, provider, status: f.status, delayMin: f.delay || 0, waitingFree: (f.delay || 0) > 0 });
    }
    res.json({ ok: false, reason: 'unknown_provider', message: `Unknown flight provider: ${provider}` });
  } catch (err) {
    res.json({ ok: false, reason: 'api_error', message: err.message });
  }
});

app.post('/api/sandbox-drive', (req, res) => res.status(410).json({ error: 'Simulated driver locations have been removed. Use the driver link and device GPS.' }));

// Перевірка email (для тесту)
app.post('/api/test-email', requireOperator, async (req, res) => {
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Email required' });
  
  try {
    const result = await sendEmail(to, 'Wayro Test Email', '<h1>✅ Email works!</h1><p>Your Wayro backend is configured correctly.</p>');
    res.status(result.sent ? 200 : 503).json({ success: !!result.sent, messageId: result.messageId || null, status: result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Request failed:', error.message);
  res.status(error.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'The request could not be completed.' });
});
app.listen(PORT, () => {
  console.log('\n==========================================');
  console.log(`🚖 Wayro Backend running on http://localhost:${PORT}`);
  console.log(`Gateway: ${stripe ? 'Stripe configured; verify in test mode first' : 'Online payment disabled: no Stripe key'}`);
  console.log(`📧 Email: ${transporter ? 'CONFIGURED' : 'NOT CONFIGURED (set EMAIL_USER/PASS)'}`);
  console.log('==========================================\n');
});
