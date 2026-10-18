'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { Market } = require('../src/market');
const { evaluate, backtest } = require('../src/signals/engine');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('API отдаёт рынки, свечи, страницы и 404', async () => {
  const market = new Market();
  const server = await listen(createApp(market));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const markets = await (await fetch(`${base}/api/markets`)).json();
    assert.ok(markets.length > 0);
    assert.ok(markets.every((q) => q.ask >= q.bid));

    const candles = await (await fetch(`${base}/api/candles/btcusd?limit=50`)).json();
    assert.strictEqual(candles.length, 50);
    assert.ok(candles.every((c) => c.high >= c.low));

    assert.strictEqual((await fetch(`${base}/api/candles/NOPE`)).status, 404);

    assert.strictEqual((await fetch(`${base}/`)).status, 200);
    assert.strictEqual((await fetch(`${base}/signals`)).status, 200);
    assert.strictEqual((await fetch(`${base}/auth`)).status, 200);
    assert.strictEqual((await fetch(`${base}/vendor/supabase.js`)).status, 200);

    // Старые пути редиректят на /signals
    const term = await fetch(`${base}/terminal`, { redirect: 'manual' });
    assert.strictEqual(term.status, 302);
    assert.strictEqual(term.headers.get('location'), '/signals');

    const sec = await fetch(`${base}/security`);
    assert.strictEqual(sec.status, 200);
    assert.match(sec.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(sec.headers.get('content-security-policy'), /\*\.supabase\.co/);
    assert.strictEqual(sec.headers.get('x-frame-options'), 'DENY');

    assert.strictEqual((await fetch(`${base}/missing`)).status, 404);
  } finally {
    server.close();
  }
});

test('/api/config возвращает форму { supabase: null | { url, anonKey } }', async () => {
  const server = await listen(createApp(new Market()));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/config`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    const cfg = await res.json();
    assert.ok('supabase' in cfg, 'ответ должен содержать ключ supabase');
    assert.ok(cfg.supabase === null || (cfg.supabase.url && cfg.supabase.anonKey));
  } finally {
    server.close();
  }
});

test('/api/signals/* эндпоинты работают с in-memory журналом', async () => {
  const server = await listen(createApp(new Market()));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const syms = await (await fetch(`${base}/api/signals/symbols`)).json();
    assert.ok(Array.isArray(syms.symbols));
    assert.ok(syms.symbols.length >= 1);

    const open = await (await fetch(`${base}/api/signals/open`)).json();
    assert.ok(Array.isArray(open.rows));

    const recent = await (await fetch(`${base}/api/signals/recent?limit=10`)).json();
    assert.ok(Array.isArray(recent.rows));

    const stats = await (await fetch(`${base}/api/signals/stats?days=30`)).json();
    assert.strictEqual(typeof stats.count, 'number');
    assert.strictEqual(typeof stats.winRate, 'number');
    assert.strictEqual(stats.sinceDays, 30);

    // /api/me без Authorization → 401
    const me = await fetch(`${base}/api/me/profile`);
    assert.strictEqual(me.status, 401);
  } finally {
    server.close();
  }
});

test('tick обновляет последнюю свечу', () => {
  const market = new Market();
  const [u] = market.tick();
  const last = market.candles(u.symbol).at(-1);
  assert.strictEqual(last.close, u.price);
  assert.ok(last.high >= last.close && last.low <= last.close);
});

test('движок сигналов: evaluate даёт null на плоских данных и не нарушает R:R', () => {
  // Плоские свечи (нулевая волатильность) — сигнала быть не может
  const flat = Array.from({ length: 100 }, (_, i) => ({
    time: i * 60_000, open: 100, high: 100, low: 100, close: 100, volume: 1, closed: true,
  }));
  assert.strictEqual(evaluate('BTCUSDT', flat), null);

  // Синтетика с восходящим трендом → хотя бы один LONG должен родиться по ходу
  const bt = backtest('BTCUSDT', syntheticTrend());
  // Инвариант R:R: каждый трейд, по которому цель отработала = +1.5R (или больше, если профиль поднят)
  for (const t of bt.trades) {
    assert.ok(t.rr >= 1.49, `R:R нарушен: ${t.rr}`);
    if (t.outcome === 'target') assert.ok(t.r >= 1.49, `winner r < 1.5: ${t.r}`);
    if (t.outcome === 'stop')   assert.ok(t.r <= -0.99, `loser r > -1: ${t.r}`);
  }
});

function syntheticTrend() {
  // 300 свечей: восходящий тренд с небольшим шумом — чтобы crossover точно сработал
  const out = [];
  let price = 100;
  for (let i = 0; i < 300; i++) {
    const open = price;
    const drift = 0.0015;             // +0.15% за свечу
    const noise = (Math.sin(i / 7) + Math.cos(i / 11)) * 0.004;
    const close = open * (1 + drift + noise);
    const high = Math.max(open, close) * 1.002;
    const low  = Math.min(open, close) * 0.998;
    out.push({ time: i * 60_000, open, high, low, close, volume: 100, closed: true });
    price = close;
  }
  return out;
}
