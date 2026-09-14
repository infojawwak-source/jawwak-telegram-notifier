import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://jawwak-eg.info-jawwak.workers.dev';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const REQUEST_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;
const rateBuckets = new Map();

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const allowed = FRONTEND_URL.split(',').map(v => v.trim()).filter(Boolean);
    return callback(null, allowed.includes(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '20kb' }));

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || 'unknown')
    .split(',')[0]
    .trim();
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientIp(req);
  let bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }

  bucket.count += 1;

  if (bucket.count > RATE_MAX_REQUESTS) {
    const retryAfter = Math.ceil(
      (RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000
    );
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'طلبات كثيرة خلال وقت قصير. حاول مرة أخرى بعد قليل.' });
  }

  if (rateBuckets.size > 5000) {
    for (const [ip, item] of rateBuckets) {
      if (now - item.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(ip);
    }
  }

  next();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('انتهت مهلة الاتصال بالخدمة.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function clean(value) {
  if (value === null || value === undefined || value === '') return 'غير متوفر';
  return String(value).trim();
}

function formatDate(value) {
  if (!value) return 'غير متوفر';
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  return text;
}

function formatPrice(value) {
  if (value === null || value === undefined || value === '') return 'غير متوفر';
  const number = Number(value);
  if (!Number.isFinite(number)) return clean(value);
  return `${number.toLocaleString('en-US', { maximumFractionDigits: 2 })} جنيه`;
}

function buildTelegramBookingMessage(booking) {
  const returnLine = booking.return_date
    ? `📅 العودة: ${formatDate(booking.return_date)}`
    : '';

  return [
    '🔔 حجز جديد على جوّك',
    '',
    `🎫 رقم الطلب: ${clean(booking.booking_ref)}`,
    '',
    `👤 العميل: ${clean(booking.passenger_first_name)}${booking.passenger_last_name ? ` ${clean(booking.passenger_last_name)}` : ''}`,
    `📱 الهاتف: ${clean(booking.passenger_phone)}`,
    `📧 البريد: ${clean(booking.passenger_email)}`,
    '',
    `✈️ شركة الطيران: ${clean(booking.airline_name)}`,
    `🛫 الرحلة: ${clean(booking.flight_number)}`,
    `🗺️ المسار: ${clean(booking.from_city)} (${clean(booking.from_code)}) → ${clean(booking.to_city)} (${clean(booking.to_code)})`,
    `📅 الذهاب: ${formatDate(booking.depart_date)}${booking.dep_time ? ` — ${clean(booking.dep_time)}` : ''}`,
    returnLine,
    `💺 الدرجة: ${clean(booking.cabin_class)}`,
    '',
    `💰 السعر: ${formatPrice(booking.total_price)}`,
    `📌 الحالة: ${clean(booking.status)}`,
    '',
    '⚡ راجع الطلب وتواصل مع العميل لإتمام التأكيد والدفع.'
  ].filter(Boolean).join('\n');
}

async function getBooking(bookingRef) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service غير مهيأ حالياً.');
  }

  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/bookings`);
  url.searchParams.set('select', '*');
  url.searchParams.set('booking_ref', `eq.${bookingRef}`);
  url.searchParams.set('limit', '1');

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });

  const data = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error(data?.message || data?.error_description || 'تعذر قراءة الحجز من Supabase.');
  }

  if (!Array.isArray(data) || !data[0]) {
    throw new Error('لم يتم العثور على الحجز المطلوب.');
  }

  return data[0];
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Telegram غير مهيأ حالياً.');
  }

  const response = await fetchWithTimeout(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(data?.description || 'فشل إرسال تنبيه Telegram.');
  }

  return data;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'jawwak-telegram-notifier',
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  });
});

app.post('/api/send-booking-telegram', rateLimit, async (req, res) => {
  try {
    const bookingRef = String(req.body?.bookingRef || '').trim();

    if (!bookingRef || bookingRef.length > 100) {
      return res.status(400).json({ error: 'رقم الطلب غير صالح.' });
    }

    const booking = await getBooking(bookingRef);
    await sendTelegramMessage(buildTelegramBookingMessage(booking));

    return res.json({ ok: true });
  } catch (err) {
    console.error('Telegram notification error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'تعذر إرسال تنبيه Telegram.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Jawwak Telegram notifier running on port ${PORT}`);
});
