'use strict';

// Стратегия: EMA(fast) × EMA(slow) crossover c RSI-фильтром и ATR-стопами.
// Инвариант, который держит +EV: каждый сигнал имеет R:R >= MIN_RR, иначе он не выпускается.
// При R:R = 1.5 и винрейте 55% ожидание = 0.55*1.5 - 0.45*1 = +0.375R на сделку.

const { EMA, RSI, ATR } = require('technicalindicators');

// Профили параметров per-symbol. Калибруются бэктестом. Профиль '*' — дефолт.
const PROFILES = {
  'BTCUSDT':  { emaFast: 9,  emaSlow: 21, rsiLen: 14, atrLen: 14, rsiBand: [50, 70], atrStop: 1.5, rr: 1.5 },
  'ETHUSDT':  { emaFast: 9,  emaSlow: 21, rsiLen: 14, atrLen: 14, rsiBand: [50, 70], atrStop: 1.5, rr: 1.5 },
  'SOLUSDT':  { emaFast: 7,  emaSlow: 18, rsiLen: 14, atrLen: 14, rsiBand: [55, 72], atrStop: 1.8, rr: 1.5 },
  'BNBUSDT':  { emaFast: 9,  emaSlow: 21, rsiLen: 14, atrLen: 14, rsiBand: [50, 70], atrStop: 1.5, rr: 1.5 },
  'XRPUSDT':  { emaFast: 10, emaSlow: 24, rsiLen: 14, atrLen: 14, rsiBand: [52, 70], atrStop: 1.6, rr: 1.5 },
  'DOGEUSDT': { emaFast: 12, emaSlow: 30, rsiLen: 14, atrLen: 14, rsiBand: [55, 72], atrStop: 2.0, rr: 1.5 },
  'ADAUSDT':  { emaFast: 10, emaSlow: 24, rsiLen: 14, atrLen: 14, rsiBand: [52, 70], atrStop: 1.7, rr: 1.5 },
  'LINKUSDT': { emaFast: 9,  emaSlow: 21, rsiLen: 14, atrLen: 14, rsiBand: [50, 70], atrStop: 1.6, rr: 1.5 },
  'AVAXUSDT': { emaFast: 8,  emaSlow: 20, rsiLen: 14, atrLen: 14, rsiBand: [53, 72], atrStop: 1.8, rr: 1.5 },
  'DOTUSDT':  { emaFast: 9,  emaSlow: 21, rsiLen: 14, atrLen: 14, rsiBand: [50, 70], atrStop: 1.6, rr: 1.5 },
  'ATOMUSDT': { emaFast: 9,  emaSlow: 21, rsiLen: 14, atrLen: 14, rsiBand: [52, 70], atrStop: 1.7, rr: 1.5 },
  'LTCUSDT':  { emaFast: 10, emaSlow: 24, rsiLen: 14, atrLen: 14, rsiBand: [50, 70], atrStop: 1.5, rr: 1.5 },
  '*':        { emaFast: 9,  emaSlow: 21, rsiLen: 14, atrLen: 14, rsiBand: [50, 70], atrStop: 1.5, rr: 1.5 },
};

// Антидребезг — минимум N баров между сигналами одной стороны на один символ
const COOLDOWN_BARS = 4;

function profile(sym) {
  return PROFILES[sym] || PROFILES['*'];
}

// Основная функция: получает массив закрытых свечей, возвращает сигнал или null.
// candles[] = [{ time, open, high, low, close, volume }, ...] (newest last)
function evaluate(symbol, candles, lastSignalBySide = {}) {
  const p = profile(symbol);
  const need = Math.max(p.emaSlow, p.rsiLen, p.atrLen) + 2;
  if (candles.length < need) return null;

  const c = candles.map((x) => x.close);
  const h = candles.map((x) => x.high);
  const l = candles.map((x) => x.low);

  const emaF = EMA.calculate({ period: p.emaFast, values: c });
  const emaS = EMA.calculate({ period: p.emaSlow, values: c });
  const rsi  = RSI.calculate({ period: p.rsiLen, values: c });
  const atr  = ATR.calculate({ period: p.atrLen, high: h, low: l, close: c });

  if (emaF.length < 2 || emaS.length < 2 || !atr.length || !rsi.length) return null;

  const prevSpread = emaF[emaF.length - 2] - emaS[emaS.length - 2];
  const curSpread  = emaF[emaF.length - 1] - emaS[emaS.length - 1];
  const curRsi     = rsi[rsi.length - 1];
  const curAtr     = atr[atr.length - 1];
  const price      = c[c.length - 1];
  const now        = candles[candles.length - 1].time;

  const crossedUp   = prevSpread <= 0 && curSpread > 0;
  const crossedDown = prevSpread >= 0 && curSpread < 0;

  let side = null;
  if (crossedUp   && curRsi >= p.rsiBand[0] && curRsi <= p.rsiBand[1]) side = 'LONG';
  if (crossedDown && curRsi >= 100 - p.rsiBand[1] && curRsi <= 100 - p.rsiBand[0]) side = 'SHORT';
  if (!side) return null;

  // Антидребезг: не повторяем сторону, пока не прошёл cooldown.
  const prev = lastSignalBySide[side];
  if (prev && (now - prev.time) < COOLDOWN_BARS * barMs(candles)) return null;

  // ATR должен иметь смысл — минимум 0.1% от цены, иначе плоский рынок, не торгуем.
  if (curAtr / price < 0.001) return null;

  const stopDist   = p.atrStop * curAtr;
  const stop       = side === 'LONG' ? price - stopDist : price + stopDist;
  const targetDist = p.rr * stopDist;
  const target     = side === 'LONG' ? price + targetDist : price - targetDist;

  // Инвариант R:R перед выпуском (на случай будущих правок стратегии)
  const risk   = Math.abs(price - stop);
  const reward = Math.abs(target - price);
  if (reward / risk < p.rr - 0.01) return null;

  return {
    symbol, side,
    entry: price, stop, target,
    rsi: curRsi, atr: curAtr,
    rr: reward / risk,
    time: now,
    interval: null,     // проставит caller
  };
}

function barMs(candles) {
  if (candles.length < 2) return 15 * 60_000;
  return candles[candles.length - 1].time - candles[candles.length - 2].time;
}

// Для бэктеста: прогон стратегии вперёд по истории.
function backtest(symbol, candles) {
  const p = profile(symbol);
  const trades = [];
  const lastSig = {};
  let open = null;

  for (let i = Math.max(p.emaSlow, p.rsiLen, p.atrLen) + 2; i < candles.length; i++) {
    const window = candles.slice(0, i + 1).filter((c) => c.closed !== false);
    const bar = candles[i];

    // Проверяем открытый трейд на стоп/цель на этой свече
    if (open) {
      const hitStop   = open.side === 'LONG' ? bar.low  <= open.stop   : bar.high >= open.stop;
      const hitTarget = open.side === 'LONG' ? bar.high >= open.target : bar.low  <= open.target;
      let outcome = null, exit = null;
      // Если на одной свече коснулись и стопа, и цели — считаем консервативно стоп.
      if (hitStop)   { outcome = 'stop';   exit = open.stop;   }
      else if (hitTarget) { outcome = 'target'; exit = open.target; }
      if (outcome) {
        const r = outcome === 'target' ? open.rr : -1;
        trades.push({ ...open, outcome, exit, r, closed_at: bar.time });
        open = null;
      }
    }

    if (!open) {
      const sig = evaluate(symbol, window, lastSig);
      if (sig) {
        lastSig[sig.side] = { time: sig.time };
        open = sig;
      }
    }
  }

  // Статистика
  const wins = trades.filter((t) => t.outcome === 'target').length;
  const losses = trades.filter((t) => t.outcome === 'stop').length;
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const winRate = trades.length ? wins / trades.length : 0;
  const avgR = trades.length ? totalR / trades.length : 0;
  const expectancy = winRate * p.rr - (1 - winRate) * 1;

  return { trades, stats: { count: trades.length, wins, losses, winRate, totalR, avgR, expectancy, profile: p } };
}

module.exports = { evaluate, backtest, profile, PROFILES, COOLDOWN_BARS };
