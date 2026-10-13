'use strict';

// Симулятор котировок для демо-режима: случайное блуждание с минутными свечами.
// Реальных рыночных данных здесь нет — для продакшена замените на фид биржи/провайдера.

const CANDLE_MS = 60_000;
const HISTORY = 300;

const INSTRUMENTS = [
  { symbol: 'BTCUSD', name: 'Bitcoin', group: 'crypto', price: 64250, digits: 2, vol: 0.0009 },
  { symbol: 'ETHUSD', name: 'Ethereum', group: 'crypto', price: 3120, digits: 2, vol: 0.0011 },
  { symbol: 'SOLUSD', name: 'Solana', group: 'crypto', price: 148.5, digits: 2, vol: 0.0015 },
  { symbol: 'BNBUSD', name: 'BNB', group: 'crypto', price: 575.2, digits: 2, vol: 0.001 },
  { symbol: 'XRPUSD', name: 'XRP', group: 'crypto', price: 0.5321, digits: 4, vol: 0.0014 },
  { symbol: 'DOGEUSD', name: 'Dogecoin', group: 'crypto', price: 0.1234, digits: 5, vol: 0.0018 },
  { symbol: 'EURUSD', name: 'Euro / US Dollar', group: 'forex', price: 1.0842, digits: 5, vol: 0.00012 },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', group: 'forex', price: 1.2711, digits: 5, vol: 0.00014 },
  { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', group: 'forex', price: 149.32, digits: 3, vol: 0.00013 },
  { symbol: 'AUDCAD', name: 'Australian / Canadian Dollar', group: 'forex', price: 0.9071, digits: 5, vol: 0.00012 },
  { symbol: 'XAUUSD', name: 'Gold', group: 'metals', price: 2385.4, digits: 2, vol: 0.0004 },
  { symbol: 'XAGUSD', name: 'Silver', group: 'metals', price: 28.41, digits: 3, vol: 0.0006 },
];

function round(v, digits) {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

// Нормальное распределение (Box–Muller)
function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class Market {
  constructor(instruments = INSTRUMENTS) {
    this.state = new Map();
    this.listeners = new Set();
    const now = Date.now();
    const currentStart = Math.floor(now / CANDLE_MS) * CANDLE_MS;

    for (const inst of instruments) {
      const candles = [];
      let price = inst.price;
      // Генерируем историю "назад", затем разворачиваем
      for (let i = HISTORY; i >= 1; i--) {
        const time = currentStart - i * CANDLE_MS;
        const open = price;
        let high = open;
        let low = open;
        let close = open;
        for (let t = 0; t < 12; t++) {
          close = close * (1 + gauss() * inst.vol * 0.35);
          high = Math.max(high, close);
          low = Math.min(low, close);
        }
        candles.push({ time, open, high, low, close });
        price = close;
      }
      // Подгоняем историю так, чтобы последняя цена совпала с базовой
      const k = inst.price / price;
      for (const c of candles) {
        c.open = round(c.open * k, inst.digits);
        c.high = round(c.high * k, inst.digits);
        c.low = round(c.low * k, inst.digits);
        c.close = round(c.close * k, inst.digits);
      }
      const last = inst.price;
      candles.push({ time: currentStart, open: last, high: last, low: last, close: last });

      this.state.set(inst.symbol, {
        ...inst,
        candles,
        dayOpen: candles[Math.max(0, candles.length - 1440)].open,
      });
    }
  }

  list() {
    return [...this.state.values()].map((s) => this.quote(s.symbol));
  }

  quote(symbol) {
    const s = this.state.get(symbol);
    if (!s) return null;
    const last = s.candles[s.candles.length - 1].close;
    const spread = round(last * s.vol * 0.5, s.digits) || 1 / 10 ** s.digits;
    return {
      symbol: s.symbol,
      name: s.name,
      group: s.group,
      digits: s.digits,
      price: last,
      bid: round(last - spread / 2, s.digits),
      ask: round(last + spread / 2, s.digits),
      change: round(((last - s.dayOpen) / s.dayOpen) * 100, 2),
    };
  }

  candles(symbol, limit = HISTORY) {
    const s = this.state.get(symbol);
    if (!s) return null;
    return s.candles.slice(-limit);
  }

  tick() {
    const now = Date.now();
    const start = Math.floor(now / CANDLE_MS) * CANDLE_MS;
    const updates = [];
    for (const s of this.state.values()) {
      let cur = s.candles[s.candles.length - 1];
      if (cur.time !== start) {
        cur = { time: start, open: cur.close, high: cur.close, low: cur.close, close: cur.close };
        s.candles.push(cur);
        if (s.candles.length > HISTORY * 2) s.candles.splice(0, s.candles.length - HISTORY);
      }
      const next = round(cur.close * (1 + gauss() * s.vol), s.digits);
      cur.close = next;
      cur.high = Math.max(cur.high, next);
      cur.low = Math.min(cur.low, next);
      updates.push({ ...this.quote(s.symbol), candle: { ...cur } });
    }
    for (const fn of this.listeners) fn(updates);
    return updates;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { Market, INSTRUMENTS, CANDLE_MS };
