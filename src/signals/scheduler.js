'use strict';

// Orchestrator: держит буфер свечей по подписанным символам, зовёт engine на закрытии,
// пишет сигналы в журнал, и трекер следит за открытыми сигналами по live-цене.

const { BinanceStream } = require('./stream');
const { evaluate } = require('./engine');
const journal = require('./journal');

const MAX_CANDLES = 400;
const TIMEOUT_BARS = 48;      // автозакрытие сигнала через 48 закрытых баров без хита стопа/цели

class Scheduler {
  constructor({ interval = '15m', log = console.log } = {}) {
    this.interval = interval;
    this.log = log;
    this.stream = new BinanceStream({ interval, log });
    this.buffers = new Map();         // "BTCUSDT" -> candles[]
    this.lastSignalBySide = new Map();// "BTCUSDT" -> { LONG: {time}, SHORT: {time} }
    this.openSignals = new Map();     // id -> signal row
    this.listeners = new Set();       // (event, payload) => void
    this.ready = false;

    this.stream.on((type, c) => {
      if (type === 'candle') this._onCandle(c);
      if (type === 'closedCandle') this._onClosed(c);
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(event, payload) {
    for (const fn of this.listeners) {
      try { fn(event, payload); } catch (e) { this.log('[scheduler] listener error', e); }
    }
  }

  async start(symbols) {
    const list = [...new Set(symbols.map((s) => s.toUpperCase()))];
    this.log(`[scheduler] starting with ${list.length} symbols: ${list.join(', ')}`);

    // Параллельно подгружаем историю, чтобы было на чём считать индикаторы с первой же свечи.
    await Promise.all(list.map(async (sym) => {
      try {
        const hist = await this.stream.loadHistory(sym, MAX_CANDLES);
        this.buffers.set(sym, hist);
      } catch (e) {
        this.log(`[scheduler] failed to load history for ${sym}:`, e.message);
      }
    }));
    for (const sym of list) if (this.buffers.has(sym)) this.stream.subscribe(sym);

    // Восстанавливаем открытые сигналы из журнала (при рестарте процесса)
    const open = await journal.listOpen();
    for (const row of open) this.openSignals.set(row.id, row);
    this.log(`[scheduler] restored ${open.length} open signals from journal`);

    this.ready = true;
  }

  stop() { this.stream.close(); this.ready = false; }

  _onCandle(c) {
    // Текущая цена апдейтит открытые сигналы — трекер.
    for (const [id, sig] of this.openSignals) {
      if (sig.symbol !== c.symbol) continue;
      const bar = { high: c.high, low: c.low, close: c.close, time: c.time };
      this._checkSignalExit(id, sig, bar);
    }
  }

  async _onClosed(c) {
    const buf = this.buffers.get(c.symbol);
    if (!buf) return;
    // Апдейтим последнюю свечу или добавляем новую
    const last = buf[buf.length - 1];
    if (last && last.time === c.time) Object.assign(last, c);
    else {
      buf.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, closed: true });
      if (buf.length > MAX_CANDLES * 2) buf.splice(0, buf.length - MAX_CANDLES);
    }

    // Пробуем сгенерить сигнал
    const map = this.lastSignalBySide.get(c.symbol) || {};
    const sig = evaluate(c.symbol, buf.filter((x) => x.closed), map);
    if (!sig) return;

    sig.interval = this.interval;
    map[sig.side] = { time: sig.time };
    this.lastSignalBySide.set(c.symbol, map);

    const row = await journal.insertSignal(sig);
    if (!row) return;
    this.openSignals.set(row.id, row);
    this.log(`[scheduler] new signal #${row.id} ${sig.symbol} ${sig.side} @ ${sig.entry.toFixed(4)} rr=${sig.rr.toFixed(2)}`);
    this._emit('signal', row);

    // Таймаут: автозакрытие через TIMEOUT_BARS закрытых баров
    row._openedAt = c.time;
  }

  async _checkSignalExit(id, sig, bar) {
    const long = sig.side === 'LONG';
    const hitStop   = long ? bar.low  <= sig.stop   : bar.high >= sig.stop;
    const hitTarget = long ? bar.high >= sig.target : bar.low  <= sig.target;

    let outcome = null, exit_price = null, r_multiple = null;
    // На одном баре касание и стопа и цели — консервативно считаем стоп.
    if (hitStop) {
      outcome = 'stop'; exit_price = sig.stop; r_multiple = -1;
    } else if (hitTarget) {
      outcome = 'target'; exit_price = sig.target; r_multiple = Number(sig.rr) || 1.5;
    } else {
      // Таймаут
      const openedAt = sig._openedAt || new Date(sig.entered_at).getTime();
      const elapsed = bar.time - openedAt;
      const barMs = this._intervalMs();
      if (elapsed > TIMEOUT_BARS * barMs) {
        outcome = 'timeout'; exit_price = bar.close;
        const risk = Math.abs(sig.entry - sig.stop);
        const pnl = long ? (bar.close - sig.entry) : (sig.entry - bar.close);
        r_multiple = risk ? pnl / risk : 0;
      }
    }
    if (!outcome) return;

    const updated = await journal.closeSignal(id, { outcome, exit_price, r_multiple, exited_at: bar.time });
    this.openSignals.delete(id);
    this.log(`[scheduler] closed #${id} ${sig.symbol} ${sig.side} -> ${outcome} (${r_multiple.toFixed(2)}R)`);
    this._emit('close', updated || { ...sig, id, outcome, exit_price, r_multiple });
  }

  _intervalMs() {
    const map = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
    return map[this.interval] || 900e3;
  }
}

module.exports = { Scheduler };
