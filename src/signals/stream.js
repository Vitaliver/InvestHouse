'use strict';

// Один shared WebSocket к Binance stream, с подпиской по символу и переподключением.
// Используется и движком сигналов, и трекером открытых позиций.

const WebSocket = require('ws');

const WS_URLS = [
  'wss://stream.binance.com:9443/stream',
  'wss://stream.binance.com/stream',
  'wss://data-stream.binance.vision/stream',
];
const REST_URLS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api.binance.us',
];

class BinanceStream {
  constructor({ interval = '15m', log = console.log } = {}) {
    this.interval = interval;
    this.log = log;
    this.symbols = new Set();           // активные символы, в lower-case
    this.listeners = new Set();         // (type, payload) => void
    this.ws = null;
    this.urlIdx = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.closed = false;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async loadHistory(symbol, limit = 200) {
    const sym = symbol.toUpperCase();
    let lastErr;
    for (const host of REST_URLS) {
      try {
        const r = await fetch(`${host}/api/v3/klines?symbol=${sym}&interval=${this.interval}&limit=${limit}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const rows = await r.json();
        return rows.map((k) => ({
          time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closed: true,
        }));
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('cannot reach Binance');
  }

  subscribe(symbol) {
    const s = symbol.toLowerCase();
    if (this.symbols.has(s)) return;
    this.symbols.add(s);
    this._reconnect();   // перекатываем коннекшен с новым списком стримов
  }

  unsubscribe(symbol) {
    const s = symbol.toLowerCase();
    if (!this.symbols.delete(s)) return;
    this._reconnect();
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.ws) try { this.ws.close(); } catch (e) { /* ignore */ }
  }

  _emit(type, payload) {
    for (const fn of this.listeners) {
      try { fn(type, payload); } catch (e) { this.log('[stream] listener error', e); }
    }
  }

  _reconnect() {
    if (this.closed) return;
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
    }
    clearTimeout(this.reconnectTimer);
    if (!this.symbols.size) return;      // некуда коннектиться

    const streams = [...this.symbols].map((s) => `${s}@kline_${this.interval}`).join('/');
    const url = WS_URLS[this.urlIdx % WS_URLS.length] + '?streams=' + streams;
    this.urlIdx++;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.log(`[stream] connected (${this.symbols.size} symbols)`);
      clearInterval(this.pingTimer);
      // Binance закрывает соединение каждые 24ч; keep-alive через pong
      this.pingTimer = setInterval(() => { try { ws.ping(); } catch (e) { /* ignore */ } }, 180_000);
    });

    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      const d = msg.data;
      if (!d || !d.k) return;
      const k = d.k;
      const candle = {
        symbol: d.s, time: k.t, open: +k.o, high: +k.h, low: +k.l,
        close: +k.c, volume: +k.v, closed: !!k.x, interval: k.i,
      };
      this._emit('candle', candle);
      if (candle.closed) this._emit('closedCandle', candle);
    });

    ws.on('error', (e) => this.log('[stream] error', e.message));
    ws.on('close', () => {
      if (this.closed || this.ws !== ws) return;
      this.log('[stream] disconnected, reconnecting…');
      this.reconnectTimer = setTimeout(() => this._reconnect(), 2000 + Math.random() * 2000);
    });
  }
}

module.exports = { BinanceStream, REST_URLS, WS_URLS };
