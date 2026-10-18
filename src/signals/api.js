'use strict';

// HTTP API сигнал-платформы. Монтируется в server.js на /api/signals и /api/me.

const journal = require('./journal');

// Клиент под JWT юзера — RLS применяется, видит только своё.
function userClient(req) {
  const auth = req.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${m[1]}` } },
    auth: { persistSession: false },
  });
}

function requireUser(req, res) {
  const client = userClient(req);
  if (!client) {
    res.status(401).json({ error: 'auth required' });
    return null;
  }
  return client;
}

function random6() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function mount(app, { tracked, telegram, getBotUsername }) {
  // ---------- Публичные (для авторизованных) ----------
  app.get('/api/signals/symbols', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ symbols: tracked });
  });

  app.get('/api/signals/recent', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
    const outcome = req.query.outcome ? String(req.query.outcome) : undefined;
    const rows = await journal.listRecent({ limit, symbol, outcome });
    res.json({ rows });
  });

  app.get('/api/signals/open', async (req, res) => {
    const rows = await journal.listOpen();
    res.json({ rows });
  });

  app.get('/api/signals/stats', async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const s = await journal.stats({ sinceDays: days });
    res.json(s);
  });

  // ---------- Персональные ----------
  app.get('/api/me/profile', async (req, res) => {
    const sb = requireUser(req, res); if (!sb) return;
    const { data: u } = await sb.auth.getUser();
    if (!u || !u.user) return res.status(401).json({ error: 'invalid token' });
    const userId = u.user.id;

    let { data } = await sb.from('user_profile').select('*').eq('user_id', userId).maybeSingle();
    if (!data) {
      // Создаём пустой профиль при первом обращении
      const ins = await sb.from('user_profile').insert({ user_id: userId, symbols: [] }).select().single();
      data = ins.data;
    }
    res.json({
      user: { id: userId, email: u.user.email },
      profile: {
        symbols: data.symbols || [],
        telegramLinked: !!data.telegram_chat_id,
        telegramPaused: !!data.telegram_paused,
        telegramLinkCode: data.telegram_link_code || null,
      },
      telegram: {
        enabled: !!telegram.enabled && telegram.enabled(),
        botUsername: getBotUsername ? getBotUsername() : null,
      },
    });
  });

  app.post('/api/me/profile/symbols', async (req, res) => {
    const sb = requireUser(req, res); if (!sb) return;
    const { data: u } = await sb.auth.getUser();
    if (!u || !u.user) return res.status(401).json({ error: 'invalid token' });
    const userId = u.user.id;

    const incoming = Array.isArray(req.body.symbols) ? req.body.symbols : [];
    const whitelist = new Set(tracked);
    const symbols = [...new Set(incoming.map((s) => String(s).toUpperCase()))].filter((s) => whitelist.has(s));
    if (symbols.length > 25) return res.status(400).json({ error: 'maximum 25 symbols' });

    const { data, error } = await sb
      .from('user_profile')
      .upsert({ user_id: userId, symbols })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ symbols: data.symbols || [] });
  });

  app.post('/api/me/telegram/link', async (req, res) => {
    const sb = requireUser(req, res); if (!sb) return;
    const { data: u } = await sb.auth.getUser();
    if (!u || !u.user) return res.status(401).json({ error: 'invalid token' });
    const userId = u.user.id;

    if (!telegram.enabled || !telegram.enabled()) {
      return res.status(503).json({ error: 'Telegram not configured on server' });
    }

    const code = random6();
    const { error } = await sb
      .from('user_profile')
      .upsert({ user_id: userId, telegram_link_code: code });
    if (error) return res.status(500).json({ error: error.message });

    const bot = getBotUsername && getBotUsername();
    res.json({
      code,
      botUsername: bot,
      deepLink: bot ? `https://t.me/${bot}?start=${code}` : null,
    });
  });

  app.post('/api/me/telegram/unlink', async (req, res) => {
    const sb = requireUser(req, res); if (!sb) return;
    const { data: u } = await sb.auth.getUser();
    if (!u || !u.user) return res.status(401).json({ error: 'invalid token' });
    const userId = u.user.id;
    const { error } = await sb
      .from('user_profile')
      .update({ telegram_chat_id: null, telegram_link_code: null, telegram_linked_at: null })
      .eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });
}

module.exports = { mount };
