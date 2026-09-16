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
    return res.status(429).json({ error: 'Ø·ÙØ¨Ø§Øª ÙØ«ÙØ±Ø© Ø®ÙØ§Ù ÙÙØª ÙØµÙØ±. Ø­Ø§ÙÙ ÙØ±Ø© Ø£Ø®Ø±Ù Ø¨Ø¹Ø¯ ÙÙÙÙ.' });
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
    if (err?.name === 'AbortError') throw new Error('Ø§ÙØªÙØª ÙÙÙØ© Ø§ÙØ§ØªØµØ§Ù Ø¨Ø§ÙØ®Ø¯ÙØ©.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function clean(value) {
  if (value === null || value === undefined || value === '') return 'ØºÙØ± ÙØªÙÙØ±';
  return String(value).trim();
}

function formatDate(value) {
  if (!value) return 'ØºÙØ± ÙØªÙÙØ±';
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  return text;
}

function formatPrice(value) {
  if (value === null || value === undefined || value === '') return 'ØºÙØ± ÙØªÙÙØ±';
  const number = Number(value);
  if (!Number.isFinite(number)) return clean(value);
  return `${number.toLocaleString('en-US', { maximumFractionDigits: 2 })} Ø¬ÙÙÙ`;
}

function extractNotePreference(notes, label) {
  const text = String(notes || '');
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(escaped + '\\s*:\\s*([^\\n.]+)'));
  return match?.[1]?.trim() || 'ØºÙØ± ÙØªÙÙØ±';
}

function buildTelegramBookingMessage(booking) {
  const returnLine = booking.return_date
    ? `ð ØªØ§Ø±ÙØ® Ø§ÙØ¹ÙØ¯Ø©: ${formatDate(booking.return_date)}${booking.return_dep_time ? ` â ${clean(booking.return_dep_time)}` : ''}`
    : null;
  const statusMap = { pending: 'ÙÙØ¯ Ø§ÙÙØ±Ø§Ø¬Ø¹Ø©', confirmed: 'ØªÙ Ø§ÙØªØ£ÙÙØ¯', completed: 'ÙÙØªÙÙ', cancelled: 'ÙÙØºÙ' };
  const paymentMap = { paid: 'ÙØ¯ÙÙØ¹', unpaid: 'ØºÙØ± ÙØ¯ÙÙØ¹', pending: 'ÙÙØ¯ Ø§ÙØ§ÙØªØ¸Ø§Ø±' };
  const cabinMap = { economy: 'Ø§ÙØªØµØ§Ø¯Ù', premium_economy: 'Ø§ÙØªØµØ§Ø¯Ù ÙÙÙØ²', business: 'Ø±Ø¬Ø§Ù Ø£Ø¹ÙØ§Ù', first: 'Ø¯Ø±Ø¬Ø© Ø£ÙÙÙ' };

  const seatPreference = extractNotePreference(booking.notes, 'ØªÙØ¶ÙÙ Ø§ÙÙÙØ¹Ø¯') || 'ÙØ§ ÙÙØ¬Ø¯ ØªÙØ¶ÙÙ';
  const baggagePreference = clean(booking.baggage_option) !== 'ØºÙØ± ÙØªÙÙØ±'
    ? clean(booking.baggage_option)
    : (extractNotePreference(booking.notes, 'ØªÙØ¶ÙÙ Ø§ÙØ£ÙØªØ¹Ø©') || 'ØºÙØ± ÙØªÙÙØ±');

  return [
    'ð Ø­Ø¬Ø² Ø¬Ø¯ÙØ¯ Ø¹ÙÙ Ø¬ÙÙÙ',
    'ââââââââââââââââââââ',
    `ð« Ø±ÙÙ Ø§ÙØ­Ø¬Ø²: ${clean(booking.booking_ref)}`,
    `ð ØªØ§Ø±ÙØ® Ø¥ÙØ´Ø§Ø¡ Ø§ÙØ·ÙØ¨: ${formatDate(booking.created_at)}`,
    '',
    'ð¤ Ø¨ÙØ§ÙØ§Øª Ø§ÙØ¹ÙÙÙ',
    `Ø§ÙØ§Ø³Ù: ${clean(booking.passenger_first_name)}${booking.passenger_last_name ? ` ${clean(booking.passenger_last_name)}` : ''}`,
    `ð± Ø§ÙÙØ§ØªÙ: ${clean(booking.passenger_phone)}`,
    `ð§ Ø§ÙØ¨Ø±ÙØ¯ Ø§ÙØ¥ÙÙØªØ±ÙÙÙ: ${clean(booking.passenger_email)}`,
    `ð Ø±ÙÙ Ø¬ÙØ§Ø² Ø§ÙØ³ÙØ±: ${clean(booking.passport_number)}`,
    '',
    'ðº ØªÙØ¶ÙÙØ§Øª Ø§ÙØ¹ÙÙÙ',
    `Ø§ÙÙÙØ¹Ø¯: ${seatPreference}`,
    `ð§³ Ø§ÙØ£ÙØªØ¹Ø©: ${baggagePreference}`,
    '',
    'âï¸ ØªÙØ§ØµÙÙ Ø§ÙØ±Ø­ÙØ©',
    `Ø´Ø±ÙØ© Ø§ÙØ·ÙØ±Ø§Ù: ${clean(booking.airline_name)}`,
    `âï¸ Ø±ÙÙ Ø§ÙØ±Ø­ÙØ©: ${clean(booking.flight_number)}`,
    `ðºï¸ Ø§ÙÙØ³Ø§Ø±: ${clean(booking.from_city)} (${clean(booking.from_code)}) â ${clean(booking.to_city)} (${clean(booking.to_code)})`,
    `ð ØªØ§Ø±ÙØ® Ø§ÙØ°ÙØ§Ø¨: ${formatDate(booking.depart_date)}${booking.dep_time ? ` â ${clean(booking.dep_time)}` : ''}`,
    returnLine,
    `ðª Ø§ÙØ¯Ø±Ø¬Ø©: ${cabinMap[booking.cabin_class] || clean(booking.cabin_class)}`,
    `ð¥ Ø§ÙÙØ³Ø§ÙØ±ÙÙ: ${clean(booking.adults)} Ø¨Ø§ÙØº${Number(booking.children || 0) ? ` + ${booking.children} Ø·ÙÙ` : ''}${Number(booking.infants || 0) ? ` + ${booking.infants} Ø±Ø¶ÙØ¹` : ''}`,
    `â±ï¸ ÙØ¯Ø© Ø§ÙØ±Ø­ÙØ©: ${clean(booking.duration)}`,
    '',
    'ð° Ø§ÙØ¯ÙØ¹ ÙØ§ÙØ­Ø§ÙØ©',
    `ðµ Ø§ÙØ³Ø¹Ø±: ${formatPrice(booking.total_price)}`,
    `ð Ø­Ø§ÙØ© Ø§ÙØ­Ø¬Ø²: ${statusMap[booking.status] || clean(booking.status)}`,
    `ð³ Ø­Ø§ÙØ© Ø§ÙØ¯ÙØ¹: ${paymentMap[booking.payment_status] || clean(booking.payment_status)}`,
    '',
    'â¡ ÙØ±Ø¬Ù ÙØ±Ø§Ø¬Ø¹Ø© Ø§ÙØ·ÙØ¨ ÙØ§ÙØªÙØ§ØµÙ ÙØ¹ Ø§ÙØ¹ÙÙÙ ÙØ¥ØªÙØ§Ù Ø§ÙØªØ£ÙÙØ¯ ÙØ§ÙØ¯ÙØ¹.'
  ].filter(Boolean).join('\n');
}

async function getBooking(bookingRef) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase service ØºÙØ± ÙÙÙØ£ Ø­Ø§ÙÙØ§Ù.');
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
    throw new Error(data?.message || data?.error_description || 'ØªØ¹Ø°Ø± ÙØ±Ø§Ø¡Ø© Ø§ÙØ­Ø¬Ø² ÙÙ Supabase.');
  }

  if (!Array.isArray(data) || !data[0]) {
    throw new Error('ÙÙ ÙØªÙ Ø§ÙØ¹Ø«ÙØ± Ø¹ÙÙ Ø§ÙØ­Ø¬Ø² Ø§ÙÙØ·ÙÙØ¨.');
  }

  return data[0];
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Telegram ØºÙØ± ÙÙÙØ£ Ø­Ø§ÙÙØ§Ù.');
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
    throw new Error(data?.description || 'ÙØ´Ù Ø¥Ø±Ø³Ø§Ù ØªÙØ¨ÙÙ Telegram.');
  }

  return data;
}

async function getBookingForTracking(bookingRef) {
  const booking = await getBooking(bookingRef);
  return booking;
}

function trackingSeatPreference(notes) {
  return extractNotePreference(notes, 'ØªÙØ¶ÙÙ Ø§ÙÙÙØ¹Ø¯') || 'ÙØ§ ÙÙØ¬Ø¯ ØªÙØ¶ÙÙ';
}

app.get('/api/booking-tracking', rateLimit, async (req, res) => {
  try {
    const bookingRef = String(req.query?.bookingRef || '').trim().toUpperCase();

    if (!/^JWK-[0-9]{6}-[A-Z0-9]{6}$/.test(bookingRef)) {
      return res.status(400).json({ ok: false, error: 'Ø±ÙÙ Ø§ÙØ­Ø¬Ø² ØºÙØ± ØµØ§ÙØ­.' });
    }

    const booking = await getBookingForTracking(bookingRef);

    return res.json({
      ok: true,
      booking: {
        booking_ref: booking.booking_ref,
        status: booking.status || 'pending',
        payment_status: booking.payment_status || 'unpaid',
        from_city: booking.from_city,
        from_code: booking.from_code,
        to_city: booking.to_city,
        to_code: booking.to_code,
        trip_type: booking.trip_type,
        depart_date: booking.depart_date,
        return_date: booking.return_date,
        airline_name: booking.airline_name,
        flight_number: booking.flight_number,
        dep_time: booking.dep_time,
        arr_time: booking.arr_time,
        duration: booking.duration,
        baggage_option: booking.baggage_option || extractNotePreference(booking.notes, 'ØªÙØ¶ÙÙ Ø§ÙØ£ÙØªØ¹Ø©'),
        seat_preference: trackingSeatPreference(booking.notes),
        created_at: booking.created_at
      }
    });
  } catch (err) {
    const message = err?.message || '';
    const notFound = message.includes('ÙÙ ÙØªÙ Ø§ÙØ¹Ø«ÙØ±');
    console.error('Booking tracking error:', err);
    return res.status(notFound ? 404 : 500).json({
      ok: false,
      error: notFound ? 'ÙÙ ÙØªÙ Ø§ÙØ¹Ø«ÙØ± Ø¹ÙÙ Ø­Ø¬Ø² Ø¨ÙØ°Ø§ Ø§ÙØ±ÙÙ.' : 'ØªØ¹Ø°Ø± ÙØ±Ø§Ø¡Ø© Ø­Ø§ÙØ© Ø§ÙØ­Ø¬Ø² Ø­Ø§ÙÙØ§Ù. Ø­Ø§ÙÙ ÙØ±Ø© Ø£Ø®Ø±Ù.'
    });
  }
});

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
      return res.status(400).json({ error: 'Ø±ÙÙ Ø§ÙØ·ÙØ¨ ØºÙØ± ØµØ§ÙØ­.' });
    }

    const booking = await getBooking(bookingRef);
    await sendTelegramMessage(buildTelegramBookingMessage(booking));

    return res.json({ ok: true });
  } catch (err) {
    console.error('Telegram notification error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'ØªØ¹Ø°Ø± Ø¥Ø±Ø³Ø§Ù ØªÙØ¨ÙÙ Telegram.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Jawwak Telegram notifier running on port ${PORT}`);
});
