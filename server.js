const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ Email Transporter ============
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
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
if (STRIPE_KEY && !STRIPE_KEY.includes('placeholder')) {
  try {
    stripe = require('stripe')(STRIPE_KEY);
    console.log('✓ Stripe gateway initialized');
  } catch (err) {
    console.warn('! Stripe init error:', err.message);
  }
}

app.use(cors());
app.use(express.json());

// Webhook для Stripe (сирий body)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (stripe && webhookSecret) {
    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const order = ORDERS.get(session.client_reference_id);
        if (order) {
          order.paymentStatus = 'succeeded';
          order.stripeSessionId = session.id;
          order.paidAt = new Date().toISOString();
          await sendEmail(order.email, 'Платіж підтверджено', paymentSuccessTemplate(order));
        }
        console.log(`✓ Payment confirmed: ${session.client_reference_id}`);
      }
      return res.json({ received: true });
    } catch (err) {
      console.error('Webhook verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
  res.json({ received: true });
});

app.use(express.static(path.join(__dirname)));

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
  { n: 'Karlovy Vary', g: 'cz', km: 130, lat: 50.2326, lng: 12.8714 },
  { n: 'Brno', g: 'cz', km: 205, lat: 49.1951, lng: 16.6068 },
  { n: 'Vídeň / Vienna', g: 'eu', km: 335, lat: 48.2082, lng: 16.3738 },
  { n: 'Berlín / Berlin', g: 'eu', km: 350, lat: 52.5200, lng: 13.4050 }
];

const MEETS = {
  t1: { t: 'Terminál 1', s: 'Mattoni Bar', lat: 50.1028, lng: 14.2580 },
  t2: { t: 'Terminál 2', s: 'Visitor Centre', lat: 50.1069, lng: 14.2647 },
  hn: { t: 'Praha Hlavní nádraží', s: 'Burger King', lat: 50.0831, lng: 14.4360 }
};

const ORDERS = new Map();
const DRIVER_POSITIONS = new Map();

const place = name => PLACES.find(p => p.n.toLowerCase() === String(name || '').trim().toLowerCase());

// ============ Розрахунок ціни ============
function calculateServerPrice(booking) {
  const car = FLEET_TARIFFS[booking.car] || FLEET_TARIFFS.sedan;
  let base = car.base;
  let priceType = 'estimate';

  if (booking.mode === 'hourly') {
    const hours = Math.max(2, parseInt(booking.hours, 10) || 2);
    base = car.hour * hours;
    priceType = 'hourly';
  } else {
    const from = place(booking.from);
    const to = place(booking.to);
    if (from && to) {
      const groups = [from.g, to.g];
      if (groups.includes('prg') && groups.includes('prg-city')) {
        base = car.base;
        priceType = 'fixed';
      } else if (from.g === 'prg-city' && to.g === 'prg-city') {
        const km = Math.max(3, Math.abs(from.km - to.km) + 3);
        base = Math.max(car.city, Math.round((km * car.rate) / 10) * 10);
      } else {
        const far = from.g === 'prg' || from.g === 'prg-city' ? to : from;
        const km = far.km + (groups.includes('prg') ? 17 : 0);
        base = Math.round((km * car.rate + car.base * 0.4) / 10) * 10;
      }
    }
  }

  const returnMultiplier = booking.roundtrip && booking.mode !== 'hourly' ? 2 : 1;
  let subtotal = base * returnMultiplier;

  let discount = 0;
  if (booking.promo === 'WAYRO10' || (booking.promo && booking.promo.startsWith('WY-'))) {
    discount = Math.round(subtotal * 0.10);
  } else if (booking.promo === 'PRG15') {
    discount = Math.round(subtotal * 0.15);
  }

  return { base, subtotal, discount, total: Math.max(0, subtotal - discount), currency: 'CZK', priceType };
}

// ============ Email Templates ============
function bookingConfirmationTemplate(order) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body{font-family:system-ui,sans-serif;background:#0d0c08;color:#e9e2d2;padding:24px}
  .card{max-width:520px;margin:0 auto;background:#141209;border:1px solid #2c2819;border-radius:12px;padding:28px}
  h1{color:#f5c66b;font-size:22px;margin:0 0 18px}
  .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #262319}
  .row:last-child{border:0}
  .label{color:#8a8474;font-size:12px}
  .value{color:#ddd5c4;font-weight:500}
  .total{font-size:24px;color:#f5c66b;font-weight:700}
  .footer{margin-top:24px;font-size:11px;color:#6b6558;text-align:center}
  .btn{display:inline-block;background:#f5c66b;color:#171204;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:16px}
</style></head>
<body>
  <div class="card">
    <h1>🚖 Wayro – Підтвердження замовлення</h1>
    <p style="color:#9c9585;font-size:13px;line-height:1.6;margin-bottom:20px">
      Дякуємо за замовлення! Ваш трансфер очікує підтвердження диспетчером.
    </p>
    
    <div class="row"><span class="label">Номер замовлення</span><span class="value">${order.id}</span></div>
    <div class="row"><span class="label">Звідки</span><span class="value">${order.booking.from}</span></div>
    <div class="row"><span class="label">Куди</span><span class="value">${order.booking.to}</span></div>
    <div class="row"><span class="label">Дата і час</span><span class="value">${order.booking.date} ${order.booking.time}</span></div>
    <div class="row"><span class="label">Автомобіль</span><span class="value">${order.booking.car}</span></div>
    <div class="row"><span class="label">Пасажирів</span><span class="value">${order.booking.pax || 1}</span></div>
    <div class="row"><span class="label">Спосіб оплати</span><span class="value">${order.paymentStatus === 'pay_on_arrival' ? 'Готівкою/картою водію' : 'Онлайн карткою'}</span></div>
    <div class="row"><span class="label">Сума</span><span class="total">${order.amount} ${order.currency}</span></div>
    
    <div style="text-align:center">
      <a href="${process.env.CLIENT_URL}/#/jizda/${encodeURIComponent(order.id)}" class="btn">Переглянути замовлення</a>
    </div>
    
    <div class="footer">
      Wayro Transfer · Prague Airport<br>
      Це автоматичний лист, будь ласка не відповідайте.
    </div>
  </div>
</body>
</html>`;
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
    console.log(`📧 Email (dry run) to ${to}: ${subject}`);
    return { messageId: 'dry-run' };
  }
  
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'Wayro Transfer <noreply@wayro.cz>',
      to,
      subject,
      html
    });
    console.log(`📧 Email sent to ${to}: ${subject} (${info.messageId})`);
    return info;
  } catch (err) {
    console.error('Email error:', err.message);
    throw err;
  }
}

// ============ API Endpoints ============

// Створення замовлення + email
app.post('/api/checkout', async (req, res) => {
  try {
    const { booking, returnUrl } = req.body;
    if (!booking) return res.status(400).json({ error: 'Missing booking payload' });

    const price = calculateServerPrice(booking);
    const orderId = `WY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const wantsOnlinePayment = booking.pay === 'online';
    const order = {
      orderId,
      booking,
      amount: price.total,
      currency: price.currency,
      paymentStatus: wantsOnlinePayment ? 'pending' : 'pay_on_arrival',
      email: booking.email,
      name: booking.name,
      createdAt: new Date().toISOString()
    };
    ORDERS.set(orderId, order);

    // Відправка email підтвердження
    if (order.email) {
      try {
        await sendEmail(order.email, `Wayro – Замовлення ${orderId}`, bookingConfirmationTemplate(order));
      } catch (e) {
        console.warn('Email failed, continuing anyway:', e.message);
      }
    }

    if (!wantsOnlinePayment) {
      return res.json({
        orderId,
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
              name: `Wayro Transfer: ${booking.from} -> ${booking.to}`,
              description: `Vehicle: ${booking.car}, Pax: ${booking.pax || 1}`
            },
            unit_amount: Math.round(price.total * 100)
          },
          quantity: 1
        }],
        mode: 'payment',
        success_url: `${returnUrl || 'http://localhost:3000/#/jizdy'}?orderId=${orderId}&payment=success`,
        cancel_url: `${returnUrl || 'http://localhost:3000/#/jizdy'}?orderId=${orderId}&payment=cancelled`
      });

      return res.json({
        orderId,
        confirmationUrl: session.url,
        amount: { value: price.total, currency: 'CZK' }
      });
    }

    // Sandbox gateway
    const simulatedGatewayUrl = `/payment-gateway.html?orderId=${encodeURIComponent(orderId)}&amount=${price.total}&currency=CZK&returnUrl=${encodeURIComponent(returnUrl || '/#/jizdy')}`;

    return res.json({
      orderId,
      confirmationUrl: simulatedGatewayUrl,
      amount: { value: price.total, currency: 'CZK' }
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message || 'Payment processing failed' });
  }
});

// Перевірка статусу замовлення
app.get('/api/order-status', (req, res) => {
  const { orderId } = req.query;
  const order = ORDERS.get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  res.json({
    orderId,
    paymentStatus: order.paymentStatus,
    amount: { value: order.amount, currency: order.currency },
    timestamp: new Date().toISOString()
  });
});

// Отримати позицію водія
app.get('/api/driver/:orderId', (req, res) => {
  const { orderId } = req.params;
  const order = ORDERS.get(orderId);
  const driver = DRIVER_POSITIONS.get(orderId);
  
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  res.json({
    assigned: !!driver,
    lat: driver?.lat || null,
    lng: driver?.lng || null,
    progress: driver?.progress || 0,
    speedKmh: driver?.speedKmh || 0,
    etaSec: driver?.etaSec || 0,
    remainingKm: driver?.remainingKm || 0,
    updatedAt: driver?.updatedAt || null,
    source: driver ? 'driver-app' : 'dispatch'
  });
});

// Sandbox: емуляція руху водія
app.post('/api/sandbox-drive', (req, res) => {
  const { orderId, action } = req.body || {};
  const order = ORDERS.get(orderId);
  
  if (!order) return res.status(404).json({ error: 'Order not found' });
  
  if (action === 'stop') {
    DRIVER_POSITIONS.delete(orderId);
    return res.json({ assigned: false, orderId });
  }
  
  // Start simulation
  const from = place(order.booking.from);
  const to = place(order.booking.to);
  
  if (!from || !to) {
    return res.json({ assigned: false, error: 'No coordinates for route' });
  }
  
  const totalDist = Math.hypot(to.lat - from.lat, (to.lng - from.lng) * Math.cos(from.lat * Math.PI / 180)) * 111.32;
  const durationSec = Math.max(120, totalDist * 60); // ~60 sec per km
  const startTime = Date.now();
  
  const simulate = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const progress = Math.min(1, elapsed / durationSec);
    const lat = from.lat + (to.lat - from.lat) * progress;
    const lng = from.lng + (to.lng - from.lng) * progress;
    const remaining = totalDist * (1 - progress);
    
    DRIVER_POSITIONS.set(orderId, {
      lat,
      lng,
      progress,
      speedKmh: 35 + Math.random() * 15,
      etaSec: remaining * 60,
      remainingKm: remaining,
      updatedAt: new Date().toISOString()
    });
    
    if (progress < 1) {
      setTimeout(simulate, 2000);
    }
  };
  
  simulate();
  
  res.json({ assigned: true, orderId, message: 'Driver simulation started' });
});

// Перевірка email (для тесту)
app.post('/api/test-email', async (req, res) => {
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Email required' });
  
  try {
    const result = await sendEmail(to, 'Wayro Test Email', '<h1>✅ Email works!</h1><p>Your Wayro backend is configured correctly.</p>');
    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('\n==========================================');
  console.log(`🚖 Wayro Backend running on http://localhost:${PORT}`);
  console.log(`📦 Gateway: ${stripe ? 'STRIPE LIVE/TEST' : 'SANDBOX (set STRIPE_SECRET_KEY for real cards)'}`);
  console.log(`📧 Email: ${transporter ? 'CONFIGURED' : 'NOT CONFIGURED (set EMAIL_USER/PASS)'}`);
  console.log('==========================================\n');
});
