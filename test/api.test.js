'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { Market } = require('../src/market');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('API отдаёт рынки, свечи и 404', async () => {
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
    assert.strictEqual((await fetch(`${base}/terminal`)).status, 200);
    assert.strictEqual((await fetch(`${base}/missing`)).status, 404);
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
