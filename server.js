try { require('dotenv').config(); } catch (e) {}
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Bot, InlineKeyboard, GrammyError, HttpError } = require('grammy');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Artemkin3003!';
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const PAYMENT_PHONE = process.env.PAYMENT_PHONE || '+79226466607';
const PAYMENT_NAME = process.env.PAYMENT_NAME || 'Варвара Сергеевна С';
const PAYMENT_BANK = process.env.PAYMENT_BANK || 'Сбербанк';
const PREPAYMENT = parseInt(process.env.PREPAYMENT_AMOUNT || '300');
let ADMIN_TG_ID = process.env.ADMIN_TG_ID || null;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не указан в .env');
  process.exit(1);
}

// === Простое JSON-хранилище ===
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(dbFile)) {
      return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    }
  } catch (e) {}
  return { slots: [], sessions: [], settings: {}, clients: [] };
}

function saveDB(db) {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

let db = loadDB();

// Предзаполняем занятые слоты, если база пустая
if (db.slots.length === 0) {
  const existing = [
    { date: '2026-11-06', time: '15:00' },
    { date: '2026-11-08', time: '12:00' },
    { date: '2026-11-10', time: '12:00' },
    { date: '2026-11-11', time: '12:00' },
    { date: '2026-11-11', time: '15:00' },
    { date: '2026-11-13', time: '12:00' },
    { date: '2026-11-13', time: '15:00' },
  ];
  existing.forEach(b => {
    db.slots.push({
      id: uuidv4(),
      date: b.date,
      time: b.time,
      status: 'booked',
      client_name: null,
      client_username: null,
      client_phone: null,
      client_tg_id: null,
      service: null,
      comment: null,
      photos: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  });
  saveDB(db);
}

// Прайс
const PRICE_LIST = {
  extension: [
    { id: 'ext_1_2', name: 'Наращивание длина 1–2', price: 2000 },
    { id: 'ext_3_4', name: 'Наращивание длина 3–4', price: 2300 },
    { id: 'ext_5_6', name: 'Наращивание длина 5–6', price: 2600 },
  ],
  natural: [
    { id: 'gel', name: 'Покрытие натуральных ногтей', price: 1500 },
    { id: 'model', name: 'Моделирование', price: 1800 },
  ],
  design: [
    { id: 'light', name: 'Дизайн Light', price: 200 },
    { id: 'medium', name: 'Дизайн Medium', price: 400 },
    { id: 'hard', name: 'Дизайн Hard', price: 600 },
    { id: 'french', name: 'Френч', price: 500 },
    { id: 'special', name: 'Втирка / кошачий глаз / битое стекло / аэрограф / сухоцветы', price: 300 },
  ],
  extra: [
    { id: 'remove_combo', name: 'Снятие + комбинированный маникюр', price: 1200 },
    { id: 'combo', name: 'Комбинированный маникюр', price: 1000 },
    { id: 'remove_other', name: 'Снятие работы другого мастера', price: 300 },
    { id: 'remove_my', name: 'Снятие моей работы', price: 0 },
  ]
};

app.use(cors());
app.use(bodyParser.json({ limit: '15mb' })); // для фото
app.use(express.static(path.join(__dirname, 'public')));

function checkAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = db.sessions.find(s => s.token === token);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// === API ===
app.get('/api/price', (req, res) => {
  res.json(db.settings.price_list || PRICE_LIST);
});

app.get('/api/admin/price', checkAdmin, (req, res) => {
  res.json(db.settings.price_list || PRICE_LIST);
});

app.post('/api/admin/price', checkAdmin, (req, res) => {
  if (req.body && typeof req.body === 'object') {
    db.settings.price_list = req.body;
    saveDB(db);
  }
  res.json({ ok: true });
});

app.get('/api/slots', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const slots = db.slots
    .filter(s => s.status === 'available' && s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  res.json(slots);
});

app.get('/api/admin/slots', checkAdmin, (req, res) => {
  const slots = [...db.slots].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  res.json(slots);
});

app.post('/api/admin/slots', checkAdmin, (req, res) => {
  const { date, time } = req.body;
  if (!date || !time) return res.status(400).json({ error: 'date and time required' });
  if (db.slots.find(s => s.date === date && s.time === time)) {
    return res.status(400).json({ error: 'Слот уже существует' });
  }
  const slot = {
    id: uuidv4(),
    date, time,
    status: 'available',
    client_name: null,
    client_username: null,
    client_phone: null,
    client_tg_id: null,
    service: null,
    comment: null,
    photos: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.slots.push(slot);
  saveDB(db);
  res.json(slot);
});

app.delete('/api/admin/slots/:id', checkAdmin, (req, res) => {
  db.slots = db.slots.filter(s => s.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

app.patch('/api/admin/slots/:id', checkAdmin, (req, res) => {
  const slot = db.slots.find(s => s.id === req.params.id);
  if (!slot) return res.status(404).json({ error: 'Not found' });
  const { status, client_name, client_username, client_phone, service, comment, date, time, admin_comment, price } = req.body;
  const prevStatus = slot.status;
  if (status) slot.status = status;
  if (client_name !== undefined) slot.client_name = client_name;
  if (client_username !== undefined) slot.client_username = client_username;
  if (client_phone !== undefined) slot.client_phone = client_phone;
  if (service !== undefined) slot.service = service;
  if (comment !== undefined) slot.comment = comment;
  if (date) slot.date = date;
  if (time) slot.time = time;
  if (admin_comment !== undefined) slot.admin_comment = admin_comment;
  if (price !== undefined) slot.price = price;
  slot.updated_at = new Date().toISOString();
  saveDB(db);

  // Уведомление клиенту при подтверждении + визит в базу
  if (status === 'booked' && prevStatus !== 'booked') {
    if (slot.client_tg_id) notifyClientConfirmed(slot);
    if (slot.client_phone && db.clients) {
      const pk = String(slot.client_phone).replace(/\D/g, '');
      const cl = db.clients.find(c => String(c.phone).replace(/\D/g, '') === pk);
      if (cl) { cl.visits = (cl.visits || 0) + 1; saveDB(db); }
    }
  }
  if (status === 'cancelled' && slot.client_tg_id) {
    notifyClientCancelled(slot);
  }

  res.json({ ok: true });
});

app.get('/api/my-bookings', (req, res) => {
  const tgId = String(req.query.tg_id || '');
  if (!tgId) return res.json([]);
  const list = db.slots
    .filter(s => String(s.client_tg_id) === tgId && s.status !== 'available')
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  res.json(list);
});

app.post('/api/book', (req, res) => {
  const { slot_id, client_name, client_username, client_phone, service, comment, tg_id, photos, design, price } = req.body;
  if (!slot_id || !client_name || !client_phone) {
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  }
  const slot = db.slots.find(s => s.id === slot_id);
  if (!slot) return res.status(404).json({ error: 'Слот не найден' });
  if (slot.status !== 'available') return res.status(400).json({ error: 'Слот уже занят' });

  slot.status = 'pending';
  slot.client_name = client_name;
  slot.client_username = client_username || '';
  slot.client_phone = client_phone;
  slot.client_tg_id = tg_id || '';
  slot.service = service || '';
  slot.design = design || '';
  slot.comment = comment || '';
  slot.price = price || 0;
  slot.admin_comment = '';
  slot.photos = Array.isArray(photos) ? photos.slice(0, 3) : [];
  slot.updated_at = new Date().toISOString();

  // база клиенток по телефону
  if (!db.clients) db.clients = [];
  const phoneKey = String(client_phone).replace(/\D/g, '');
  let client = db.clients.find(c => String(c.phone).replace(/\D/g, '') === phoneKey);
  if (!client) {
    client = {
      id: uuidv4(),
      phone: client_phone,
      name: client_name,
      username: client_username || '',
      tg_id: tg_id || '',
      visits: 0,
      notes: '',
      created_at: new Date().toISOString()
    };
    db.clients.push(client);
  } else {
    client.name = client_name || client.name;
    client.username = client_username || client.username;
    if (tg_id) client.tg_id = tg_id;
  }

  saveDB(db);

  notifyAdminNewBooking({
    date: slot.date,
    time: slot.time,
    name: client_name,
    username: client_username,
    phone: client_phone,
    service,
    comment,
    photosCount: slot.photos.length
  });

  res.json({ ok: true });
});

app.post('/api/paid', (req, res) => {
  const { slot_id } = req.body;
  const slot = db.slots.find(s => s.id === slot_id);
  if (!slot) return res.status(404).json({ error: 'Слот не найден' });
  notifyAdminPaymentClaimed(slot);
  res.json({ ok: true });
});

app.get('/api/qr', async (req, res) => {
  const username = (req.query.username || 'username').replace('@', '');
  const text = `Перевод ${PREPAYMENT} ₽\n${PAYMENT_BANK}: ${PAYMENT_PHONE}\n${PAYMENT_NAME}\n\nКомментарий: @${username}`;
  try {
    const qr = await QRCode.toDataURL(text, { width: 280, margin: 2 });
    res.json({ qr, phone: PAYMENT_PHONE, name: PAYMENT_NAME, bank: PAYMENT_BANK, amount: PREPAYMENT });
  } catch (e) {
    res.status(500).json({ error: 'QR failed' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body;
  if (login === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
    const token = uuidv4();
    db.sessions.push({ token, created_at: new Date().toISOString() });
    // чистим старые
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    db.sessions = db.sessions.filter(s => new Date(s.created_at).getTime() > weekAgo);
    saveDB(db);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Неверный логин или пароль' });
  }
});

app.get('/api/admin/settings', checkAdmin, (req, res) => {
  res.json({
    admin_tg_id: db.settings.admin_tg_id || ADMIN_TG_ID || '',
    payment_phone: PAYMENT_PHONE,
    prepayment: PREPAYMENT
  });
});

app.post('/api/admin/settings', checkAdmin, (req, res) => {
  if (req.body.admin_tg_id !== undefined) {
    db.settings.admin_tg_id = req.body.admin_tg_id;
    ADMIN_TG_ID = req.body.admin_tg_id;
    saveDB(db);
  }
  res.json({ ok: true });
});


app.post('/api/cancel', (req, res) => {
  const { slot_id, tg_id } = req.body;
  const slot = db.slots.find(s => s.id === slot_id);
  if (!slot) return res.status(404).json({ error: 'Не найдено' });
  if (String(slot.client_tg_id) !== String(tg_id)) {
    return res.status(403).json({ error: 'Нельзя отменить чужую запись' });
  }
  if (!['pending', 'booked'].includes(slot.status)) {
    return res.status(400).json({ error: 'Нельзя отменить' });
  }
  slot.status = 'cancelled';
  slot.updated_at = new Date().toISOString();
  saveDB(db);
  notifyClientCancelled(slot);
  const chatId = db.settings.admin_tg_id || ADMIN_TG_ID;
  if (chatId) {
    bot.api.sendMessage(chatId, `❌ Клиент отменил запись\n📅 ${slot.date} ${slot.time}\n👤 ${slot.client_name}`).catch(() => {});
  }
  res.json({ ok: true });
});

app.get('/api/admin/clients', checkAdmin, (req, res) => {
  if (!db.clients) db.clients = [];
  const q = String(req.query.q || '').replace(/\D/g, '');
  let list = [...db.clients];
  if (q) list = list.filter(c => String(c.phone).replace(/\D/g, '').includes(q) || (c.name || '').toLowerCase().includes(String(req.query.q || '').toLowerCase()));
  list.sort((a, b) => (b.visits || 0) - (a.visits || 0));
  res.json(list);
});

app.patch('/api/admin/clients/:id', checkAdmin, (req, res) => {
  if (!db.clients) db.clients = [];
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const { name, notes, visits, phone } = req.body;
  if (name !== undefined) c.name = name;
  if (notes !== undefined) c.notes = notes;
  if (visits !== undefined) c.visits = parseInt(visits) || 0;
  if (phone !== undefined) c.phone = phone;
  saveDB(db);
  res.json({ ok: true });
});

// === Bot ===
const bot = new Bot(BOT_TOKEN);

bot.command('start', async (ctx) => {
  await ctx.reply(
    `Привет! ✨\n\nЭто бот записи в *MS_NAILS*.\n\nНажми кнопку меню в углу экрана (или «Записаться»), чтобы открыть приложение и выбрать удобное время.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('admin', async (ctx) => {
  await ctx.reply(`Админ-панель скрыта. Открой Mini App.`);
});

async function notifyAdminNewBooking(data) {
  console.log('📩 Новая заявка:', data);
  const chatId = db.settings.admin_tg_id || ADMIN_TG_ID;
  if (!chatId) return;
  try {
    let text = `📩 *Новая заявка*\n\n📅 ${data.date} ${data.time}\n👤 ${data.name}\n📞 ${data.phone}`;
    if (data.username) text += `\n@${data.username.replace('@','')}`;
    if (data.service) text += `\n💅 ${data.service}`;
    if (data.comment) text += `\n💬 ${data.comment}`;
    if (data.photosCount) text += `\n🖼 Фото: ${data.photosCount}`;
    await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Notify error:', e.message);
  }
}

async function notifyAdminPaymentClaimed(slot) {
  console.log('💳 Оплата заявлена:', slot);
  const chatId = db.settings.admin_tg_id || ADMIN_TG_ID;
  if (!chatId) return;
  try {
    const text = `💳 *Клиент нажал «Я оплатил»*\n\n📅 ${slot.date} ${slot.time}\n👤 ${slot.client_name}\n📞 ${slot.client_phone}\n${slot.client_username ? '@' + slot.client_username.replace('@','') : ''}\n\nПроверь перевод и подтверди.`;
    await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Notify error:', e.message);
  }
}

async function notifyClientConfirmed(slot) {
  if (!slot.client_tg_id) return;
  try {
    await bot.api.sendMessage(slot.client_tg_id,
      `✅ *Запись подтверждена!*\n\n📅 ${slot.date} в ${slot.time}\n💅 ${slot.service || 'маникюр'}\n\nЖдём тебя ✨`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('Client notify error:', e.message);
  }
}

async function notifyClientCancelled(slot) {
  if (!slot.client_tg_id) return;
  try {
    await bot.api.sendMessage(slot.client_tg_id,
      `❌ Запись на ${slot.date} ${slot.time} отменена.\nЕсли есть вопросы — напиши мастеру.`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('Client notify error:', e.message);
  }
}

// Callback: клиент подтверждает / отменяет визит
bot.callbackQuery(/^confirm_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const slot = db.slots.find(s => s.id === id);
  if (!slot) return ctx.answerCallbackQuery({ text: 'Запись не найдена' });
  slot.client_confirmed = true;
  slot.updated_at = new Date().toISOString();
  saveDB(db);
  await ctx.editMessageText(
    `✅ Спасибо! Визит на ${slot.date} в ${slot.time} подтверждён.\nЖдём тебя ✨`
  );
  await ctx.answerCallbackQuery({ text: 'Подтверждено' });
  // уведомить админа
  const chatId = db.settings.admin_tg_id || ADMIN_TG_ID;
  if (chatId) {
    try {
      await bot.api.sendMessage(chatId, `✅ Клиент подтвердил визит\n📅 ${slot.date} ${slot.time}\n👤 ${slot.client_name}`);
    } catch (e) {}
  }
});

bot.callbackQuery(/^cancel_(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const slot = db.slots.find(s => s.id === id);
  if (!slot) return ctx.answerCallbackQuery({ text: 'Запись не найдена' });
  slot.status = 'cancelled';
  slot.updated_at = new Date().toISOString();
  saveDB(db);
  await ctx.editMessageText(
    `❌ Запись на ${slot.date} в ${slot.time} отменена.\nЕсли передумаешь — запишись заново.`
  );
  await ctx.answerCallbackQuery({ text: 'Отменено' });
  const chatId = db.settings.admin_tg_id || ADMIN_TG_ID;
  if (chatId) {
    try {
      await bot.api.sendMessage(chatId, `❌ Клиент отменил визит\n📅 ${slot.date} ${slot.time}\n👤 ${slot.client_name}`);
    } catch (e) {}
  }
});

// Напоминание за ~24 часа + авто-отмена без подтверждения + очистка
setInterval(() => {
  const now = new Date();
  let changed = false;

  // через 5 минут после отмены — слот снова свободен
  db.slots.forEach(s => {
    if (s.status !== 'cancelled') return;
    const updated = new Date(s.updated_at || s.created_at).getTime();
    if ((now.getTime() - updated) >= 5 * 60 * 1000) {
      s.status = 'available';
      s.client_name = null;
      s.client_username = null;
      s.client_phone = null;
      s.client_tg_id = null;
      s.service = null;
      s.comment = null;
      s.photos = [];
      s.client_confirmed = false;
      s.reminded = false;
      s.updated_at = now.toISOString();
      changed = true;
    }
  });

  db.slots.forEach(async (slot) => {
    if (slot.status !== 'booked' || !slot.client_tg_id) return;

    const slotDate = new Date(`${slot.date}T${slot.time}:00`);
    const diffHours = (slotDate - now) / (1000 * 60 * 60);

    // Напоминание за ~24 часа (окно 20–28 часов)
    if (!slot.reminded && diffHours > 20 && diffHours < 28) {
      try {
        const keyboard = new InlineKeyboard()
          .text('✅ Подтвердить', `confirm_${slot.id}`)
          .text('❌ Отменить', `cancel_${slot.id}`);

        await bot.api.sendMessage(
          slot.client_tg_id,
          `Добрый день!\n\nНапоминаю о вашей записи на завтра в *${slot.time}*.\n\nЕсли всё в силе, пожалуйста подтвердите ваш визит.\n\nВ случае не подтверждения записи с вашей стороны до 9:00 в день записи, запись автоматически отменяется.`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        slot.reminded = true;
        slot.client_confirmed = false;
        changed = true;
      } catch (e) {
        console.error('Reminder error:', e.message);
      }
    }

    // Авто-отмена: день записи, после 9:00, и клиент не подтвердил
    if (slot.reminded && !slot.client_confirmed) {
      const dayStart = new Date(`${slot.date}T00:00:00`);
      const nineAM = new Date(`${slot.date}T09:00:00`);
      if (now >= nineAM && now < slotDate) {
        slot.status = 'cancelled';
        slot.updated_at = now.toISOString();
        changed = true;
        try {
          await bot.api.sendMessage(
            slot.client_tg_id,
            `❌ Запись на ${slot.date} в ${slot.time} автоматически отменена, так как визит не был подтверждён до 9:00.`
          );
        } catch (e) {}
        const chatId = db.settings.admin_tg_id || ADMIN_TG_ID;
        if (chatId) {
          try {
            await bot.api.sendMessage(chatId, `⏰ Авто-отмена (нет подтверждения)\n📅 ${slot.date} ${slot.time}\n👤 ${slot.client_name}`);
          } catch (e) {}
        }
      }
    }
  });

  if (changed) saveDB(db);
}, 60 * 1000);

bot.catch((err) => {
  console.error('Bot error:', err.error || err);
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📱 WEBAPP_URL: ${WEBAPP_URL}`);
});

(async () => {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    bot.start({
      onStart: (info) => console.log(`🤖 Bot @${info.username} started`),
      drop_pending_updates: true
    });
  } catch (e) {
    console.error('Bot start failed (server still running):', e.message);
  }
})();
