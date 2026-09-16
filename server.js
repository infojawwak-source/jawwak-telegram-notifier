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

function repairMojibake(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!/[ÃÃÃÃÃ¢Ã°]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    return repaired.includes('ï¿½') ? text : repaired;
  } catch {
    return text;
  }
}

function clean(value) {
  if (value === null || value === undefined || value === '') return 'ØºÙØ± ÙØªÙÙØ±';
  return repairMojibake(String(value).trim());
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

function telegramStatus(value) {
  const map = {
    pending: '\u0642\u064a\u062f \u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629',
    confirmed: '\u062a\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f',
    completed: '\u0627\u0643\u062a\u0645\u0644 \u0627\u0644\u062d\u062c\u0632',
    cancelled: '\u062a\u0645 \u0625\u0644\u063a\u0627\u0621 \u0627\u0644\u062d\u062c\u0632'
  };
  return map[String(value || '').toLowerCase()] || clean(value);
}

function telegramPayment(value) {
  const map = {
    paid: '\u062a\u0645 \u0627\u0644\u062f\u0641\u0639',
    unpaid: '\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u062f\u0641\u0639 \u0628\u0639\u062f',
    pending: '\u0641\u064a \u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u062f\u0641\u0639'
  };
  return map[String(value || '').toLowerCase()] || clean(value);
}

function telegramCabin(value) {
  const map = {
    economy: '\u0627\u0644\u062f\u0631\u062c\u0629 \u0627\u0644\u0633\u064a\u0627\u062d\u064a\u0629',
    premium_economy: '\u0627\u0644\u0633\u064a\u0627\u062d\u064a\u0629 \u0627\u0644\u0645\u0645\u062a\u0627\u0632\u0629',
    business: '\u062f\u0631\u062c\u0629 \u0631\u062c\u0627\u0644 \u0627\u0644\u0623\u0639\u0645\u0627\u0644',
    first: '\u0627\u0644\u062f\u0631\u062c\u0629 \u0627\u0644\u0623\u0648\u0644\u0649'
  };
  return map[String(value || '').toLowerCase()] || clean(value);
}

function buildTelegramBookingMessage(booking) {
  const returnLine = booking.return_date
    ? `ð \u0627\u0644\u0639\u0648\u062f\u0629: ${formatDate(booking.return_date)}`
    : '';

  return [
    '\ud83d\udd14 \u062d\u062c\u0632 \u062c\u062f\u064a\u062f \u0639\u0644\u0649 \u062c\u0648\u0651\u0643',
    '',
    `\ud83c\udfab \u0631\u0642\u0645 \u0627\u0644\u062d\u062c\u0632: ${clean(booking.booking_ref)}`,
    '',
    `\ud83d\udc64 \u0627\u0644\u0639\u0645\u064a\u0644: ${clean(booking.passenger_first_name)}${booking.passenger_last_name ? ` ${clean(booking.passenger_last_name)}` : ''}`,
    `\ud83d\udcf1 \u0627\u0644\u0647\u0627\u062a\u0641: ${clean(booking.passenger_phone)}`,
    `\ud83d\udce7 \u0627\u0644\u0628\u0631\u064a\u062f: ${clean(booking.passenger_email)}`,
    `\ud83d\udee1\ufe0f \u0631\u0642\u0645 \u062c\u0648\u0627\u0632 \u0627\u0644\u0633\u0641\u0631: ${clean(booking.passport_number)}`,
    `\ud83d\udeb6 \u062a\u0641\u0636\u064a\u0644 \u0627\u0644\u0645\u0642\u0639\u062f: ${extractNotePreference(booking.notes, '\u062a\u0641\u0636\u064a\u0644 \u0627\u0644\u0645\u0642\u0639\u062f')}`,
    `\ud83e\uddf3 \u0627\u0644\u0623\u0645\u062a\u0639\u0629: ${clean(booking.baggage_option)}`,
    '',
    `\u2708\ufe0f \u0634\u0631\u0643\u0629 \u0627\u0644\u0637\u064a\u0631\u0627\u0646: ${clean(booking.airline_name)}`,
    `\ud83d\udeeb \u0631\u0642\u0645 \u0627\u0644\u0631\u062d\u0644\u0629: ${clean(booking.flight_number)}`,
    `\ud83d\uddfa\ufe0f \u0627\u0644\u0645\u0633\u0627\u0631: ${clean(booking.from_city)} (${clean(booking.from_code)}) \u2192 ${clean(booking.to_city)} (${clean(booking.to_code)})`,
    `\ud83d\udcc5 \u0627\u0644\u0630\u0647\u0627\u0628: ${formatDate(booking.depart_date)}${booking.dep_time ? ` \u2014 ${clean(booking.dep_time)}` : ''}`,
    returnLine,
    `\ud83d\udcba \u0627\u0644\u062f\u0631\u062c\u0629: ${telegramCabin(booking.cabin_class)}`,
    '',
    `\ud83d\udcb0 \u0627\u0644\u0633\u0639\u0631: ${formatPrice(booking.total_price)}`,
    `\ud83d\udccc \u062d\u0627\u0644\u0629 \u0627\u0644\u062d\u062c\u0632: ${telegramStatus(booking.status)}`,
    `\ud83d\udcb3 \u062d\u0627\u0644\u0629 \u0627\u0644\u062f\u0641\u0639: ${telegramPayment(booking.payment_status)}`,
    '',
    '\u26a1 \u064a\u0631\u062c\u0649 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0637\u0644\u0628 \u0648\u0627\u0644\u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0627\u0644\u0639\u0645\u064a\u0644 \u0644\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0648\u0627\u0644\u062f\u0641\u0639.'
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
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
      },
      body: Buffer.from(JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }), 'utf8'),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(data?.description || 'ÙØ´Ù Ø¥Ø±Ø³Ø§Ù ØªÙØ¨ÙÙ Telegram.');
  }

  return data;
}

app.get('/api/booking-tracking', rateLimit, async (req, res) => {
  try {
    const bookingRef = String(req.query?.bookingRef || '').trim().toUpperCase();

    if (!/^JWK-[0-9]{6}-[A-Z0-9]{6}$/.test(bookingRef)) {
      return res.status(400).json({ error: '\u0631\u0642\u0645 \u0627\u0644\u062d\u062c\u0632 \u063a\u064a\u0631 \u0635\u0627\u0644\u062d.' });
    }

    const booking = await getBooking(bookingRef);
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
        cabin_class: booking.cabin_class,
        baggage_option: booking.baggage_option || extractNotePreference(booking.notes, '\u062a\u0641\u0636\u064a\u0644 \u0627\u0644\u0623\u0645\u062a\u0639\u0629'),
        seat_preference: extractNotePreference(booking.notes, '\u062a\u0641\u0636\u064a\u0644 \u0627\u0644\u0645\u0642\u0639\u062f'),
        created_at: booking.created_at,
      },
    });
  } catch (err) {
    console.error('Booking tracking error:', err);
    return res.status(404).json({ ok: false, error: '\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0645\u0637\u0644\u0648\u0628.' });
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
