'use strict';

const path = require('path');
const express = require('express');
const { Market } = require('./src/market');

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = Number(process.env.TICK_MS) || 1000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const SIGNAL_INTERVAL = process.env.SIGNAL_INTERVAL || '15m';
const SIGNAL_PAIRS = (process.env.SIGNAL_PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,DOTUSDT,ATOMUSDT,LTCUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

function createApp(market = new Market(), { tracked = SIGNAL_PAIRS, telegram = null, getBotUsername = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  // Заголовки безопасности
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        [
          "connect-src 'self'",
          'https://*.supabase.co https://*.supabase.in',
          'wss://*.supabase.co wss://*.supabase.in',
        ].join(' '),
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (req.secure || req.get('x-forwarded-proto') === 'https') {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // ---------- Публичные ----------
  app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      supabase: SUPABASE_URL && SUPABASE_ANON_KEY ? { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY } : null,
    });
  });

  // Остатки от лендинга — рынки, свечи и SSE для бегущей строки/графика на главной.
  app.get('/api/markets', (req, res) => res.json(market.list()));
  app.get('/api/candles/:symbol', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 600);
    const candles = market.candles(req.params.symbol.toUpperCase(), limit);
    if (!candles) return res.status(404).json({ error: 'Unknown symbol' });
    res.json(candles);
  });
  app.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(market.list())}\n\n`);
    const unsubscribe = market.subscribe((updates) => {
      res.write(`data: ${JSON.stringify(updates)}\n\n`);
    });
    req.on('close', unsubscribe);
  });

  // ---------- Платформа сигналов ----------
  const signalsApi = require('./src/signals/api');
  signalsApi.mount(app, {
    tracked,
    telegram: telegram || { enabled: () => false },
    getBotUsername,
  });

  // Старый терминал убран — редиректим на новую страницу сигналов
  app.get(['/terminal', '/exchange'], (req, res) => res.redirect(302, '/signals'));

  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  });

  return app;
}

async function startSignals(log = console.log) {
  const { Scheduler } = require('./src/signals/scheduler');
  const journal = require('./src/signals/journal');
  const telegram = require('./src/signals/telegram');

  journal.init({ supabaseUrl: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY });

  // Supabase service client для telegram-привязок и для получения подписчиков пары
  let serviceClient = null;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    } catch (e) {
      log('[boot] supabase service client failed:', e.message);
    }
  }

  await telegram.init({ supabase: serviceClient, botToken: TG_BOT_TOKEN, log });

  const sched = new Scheduler({ interval: SIGNAL_INTERVAL, log });
  sched.on((event, payload) => {
    if (event === 'signal') telegram.broadcastSignal(payload).catch(() => {});
    if (event === 'close')  telegram.broadcastClose(payload).catch(() => {});
  });
  await sched.start(SIGNAL_PAIRS);
  return { sched, telegram };
}

if (require.main === module) {
  const market = new Market();
  setInterval(() => market.tick(), TICK_MS);

  (async () => {
    let telegram = null, getBotUsername = null;
    try {
      const r = await startSignals();
      telegram = r.telegram;
      getBotUsername = r.telegram.getBotUsername;
    } catch (e) {
      console.warn('[boot] signals bootstrap failed:', e.message);
    }
    const app = createApp(market, { tracked: SIGNAL_PAIRS, telegram, getBotUsername });
    app.listen(PORT, () => {
      console.log(`InvestHouse запущен: http://localhost:${PORT}`);
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.warn('[auth] SUPABASE_URL и/или SUPABASE_ANON_KEY не заданы — вход и регистрация отключены.');
      }
      if (!SUPABASE_SERVICE_ROLE_KEY) {
        console.warn('[signals] SUPABASE_SERVICE_ROLE_KEY не задан — журнал сигналов работает in-memory, Telegram-привязка невозможна.');
      }
      if (!TG_BOT_TOKEN) {
        console.warn('[signals] TG_BOT_TOKEN не задан — доставка сигналов в Telegram отключена.');
      }
    });
  })();
}

module.exports = { createApp };
