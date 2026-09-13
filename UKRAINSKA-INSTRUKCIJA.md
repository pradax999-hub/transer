# Wayro: архів інструкції

Актуальні кроки та обмеження наведені на початку `README.md`.
Наведені нижче старі твердження про повну готовність не були перевірені тестами.
Тепер потрібні Node.js 22+, GEOAPIFY_API_KEY, HTTPS і окреме посилання водію.
Симуляція GPS вимкнена; постійне фонове стеження потребує нативного застосунку.

## 🚀 Що ви отримали

Повноцінна система трансферів з:
- ✅ Онлайн-бронюванням на сайті
- ✅ Прийомом платежів (Stripe)
- ✅ Email-підтвердженням замовлень
- ✅ Live-трекінгом водія на карті
- ✅ Адаптивним дизайном (мобільний + десктоп)

---

## 📦 Встановлення

### 1. Встановіть Node.js
Завантажте з [nodejs.org](https://nodejs.org/) (версія 18+)

### 2. Встановіть залежності
```bash
cd wayro-backend
npm install
```

### 3. Налаштуйте .env
```bash
cp .env.example .env
```

Відредагуйте `.env`:

#### Обов'язково (email):
```env
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
```

#### Опціонально (платежі):
```env
STRIPE_SECRET_KEY=sk_test_your_key_here
```

### 4. Запустіть сервер
```bash
node server.js
```

### 5. Відкрийте сайт
```
http://localhost:3000
```

---

## 📧 Налаштування Email (Gmail)

### Крок 1: Увімкніть 2FA
1. Зайдіть на [Google Account](https://myaccount.google.com/security)
2. Увімкніть **Двофакторну аутентифікацію**

### Крок 2: Створіть App Password
1. Перейдіть на [App Passwords](https://myaccount.google.com/apppasswords)
2. Оберіть "Mail" і ваш пристрій
3. Скопіюйте 16-значний пароль

### Крок 3: Вставте в .env
```env
EMAIL_USER=yourname@gmail.com
EMAIL_PASS=abcd efgh ijkl mnop
EMAIL_FROM="Wayro Transfer <noreply@wayro.cz>"
```

### Крок 4: Перевірте
```bash
curl -X POST http://localhost:3000/api/test-email \
  -H "Content-Type: application/json" \
  -d '{"to":"client@example.com"}'
```

Клієнт має отримати листа!

---

## 💳 Прийом платежів (Stripe)

### 1. Створіть акаунт
Зареєструйтесь на [stripe.com](https://stripe.com)

### 2. Отримайте ключі
Dashboard → Developers → API keys

### 3. Додайте в .env
```env
STRIPE_SECRET_KEY=sk_test_51ABC...
STRIPE_WEBHOOK_SECRET=whsec_...
```

### 4. Налаштуйте Webhook
Dashboard → Developers → Webhooks
- Endpoint: `https://your-domain.com/api/webhook`
- Events: `checkout.session.completed`

### 5. Перезапустіть сервер
```bash
node server.js
```

---

## 🗺️ Live-трекінг водія

### Як це працює:
1. Клієнт робить замовлення на сайті
2. Сервер зберігає замовлення в пам'яті
3. Водійська додатка (окремий проект) шле координати на `/api/driver/:orderId`
4. Клієнт бачить авто на карті в реальному часі

### Тестування без додатки:
1. Створіть замовлення на сайті
2. Відкрийте деталь замовлення
3. Натисніть "Спостерігати за водієм"
4. Сервер емулює рух від аеропорту до центру

---

## 📱 Мобільна версія

Сайт повністю адаптивний:
- ✅ iPhone / Android
- ✅ Планшети
- ✅ Десктоп

Просто відкрийте `http://your-server-ip:3000` з телефону

---

## 🌐 Деплой на хостинг

### Railway (найпростіше)
1. Завантажте код на GitHub
2. Зайдіть на [railway.app](https://railway.app)
3. New Project → Deploy from GitHub
4. Додайте змінні оточення з `.env`
5. Готово!

### VPS (Ubuntu 22.04)
```bash
# Встановіть Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Встановіть PM2
sudo npm install -g pm2

# Клонуйте репо
git clone <your-repo>
cd wayro-backend
npm install --production

# Запустіть
pm2 start server.js --name wayro
pm2 save
pm2 startup

# Налаштуйте Nginx (опціонально)
sudo apt install nginx
sudo nano /etc/nginx/sites-available/wayro
```

Nginx конфіг:
```nginx
server {
    listen 80;
    server_name wayro.cz;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 🧪 Тестування

### 1. Створіть замовлення
- Відкрийте `http://localhost:3000`
- Заповніть форму (звідки, куди, дата)
- Оберіть авто
- Введіть email

### 2. Перевірте email
Ви маєте отримати лист з підтвердженням

### 3. Сплатіть (якщо Stripe)
- Оберіть "Online платіж"
- Введіть тестову карту: `4242 4242 4242 4242`
- Будь-яка дата в майбутньому
- Будь-який CVC

### 4. Слідкуйте за водієм
- Відкрийте деталь замовлення
- Натисніть "Спостерігати за водієм"
- Авто почне рух на карті

---

## 📊 API Довідка

### Створення замовлення
```bash
POST /api/checkout
Content-Type: application/json

{
  "booking": {
    "from": "Letiště Praha (PRG)",
    "to": "Praha – centrum",
    "date": "2025-02-01",
    "time": "14:00",
    "car": "sedan",
    "pax": 2,
    "email": "client@example.com",
    "name": "Jan Novak",
    "pay": "online"
  },
  "returnUrl": "http://localhost:3000/#/jizdy"
}
```

### Статус оплати
```bash
GET /api/order-status?orderId=WY-ABC123
```

### Позиція водія
```bash
GET /api/driver/WY-ABC123
```

### Емуляція водія
```bash
POST /api/sandbox-drive
Content-Type: application/json

{
  "orderId": "WY-ABC123",
  "action": "start"
}
```

### Тест email
```bash
POST /api/test-email
Content-Type: application/json

{
  "to": "test@example.com"
}
```

---

## ❗ Поширені проблеми

### Email не приходить
- Перевірте App Password (не звичайний пароль Gmail)
- Увімкніть 2FA в Google Account
- Перевірте спам

### Stripe не працює
- Ключ має починатися з `sk_test_` або `sk_live_`
- Webhook секрет має бути з Dashboard
- Перезапустіть сервер після змін

### Мапа не показує водія
- Запустіть `/api/sandbox-drive` для тесту
- Перевірте консоль браузера на помилки
- Переконайтесь що Leaflet.js завантажився

---

## 📞 Підтримка

Якщо щось не працює:
1. Перевірте логи сервера
2. Відкрийте консоль браузера (F12)
3. Переконайтесь що всі змінні в `.env` заповнені

Успіхів з Wayro! 🚖
