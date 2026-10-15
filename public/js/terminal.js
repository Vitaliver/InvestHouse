// Биржевой терминал InvestHouse
// Реальные данные (свечи, стакан, лента сделок, тикер 24ч) — публичное API Binance,
// REST api.binance.com + WebSocket stream.binance.com. Ключи не нужны.
// Торговля — фейковая: баланс и ордера хранятся в localStorage этого браузера.

(function () {
  'use strict';

  // ========== Конфигурация ==========
  const QUOTE = 'USDT';
  const SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
    'ADAUSDT', 'LTCUSDT', 'LINKUSDT', 'DOTUSDT', 'AVAXUSDT', 'ATOMUSDT',
    'TRXUSDT', 'TONUSDT', 'NEARUSDT', 'SHIBUSDT',
  ];
  const NAMES = {
    BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'XRP',
    DOGE: 'Dogecoin', ADA: 'Cardano', LTC: 'Litecoin', LINK: 'Chainlink',
    DOT: 'Polkadot', AVAX: 'Avalanche', ATOM: 'Cosmos', TRX: 'TRON',
    TON: 'Toncoin', NEAR: 'NEAR', SHIB: 'Shiba Inu',
  };
  // Знаки после запятой: цена / объём
  const DIGITS = {
    BTC: [2, 6], ETH: [2, 5], SOL: [3, 3], BNB: [2, 4], XRP: [4, 1],
    DOGE: [5, 0], ADA: [4, 1], LTC: [2, 4], LINK: [3, 3], DOT: [3, 3],
    AVAX: [3, 3], ATOM: [3, 3], TRX: [5, 0], TON: [3, 3], NEAR: [3, 2],
    SHIB: [8, 0],
  };
  const INTERVALS = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000,
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
  };
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
  const FEE = 0.001;              // 0.1% комиссия с каждой сделки
  const START_USDT = 10_000;      // стартовый баланс демо-счёта
  const STORE_KEY = 'investhouse.exchange.v2';
  const BOOK_ROWS = 12;           // строк на сторону стакана
  const TRADES_MAX = 40;          // длина ленты сделок
  const MAX_CANDLES = 500;

  // ========== Состояние ==========
  const state = {
    symbol: 'BTCUSDT',
    tf: '15m',
    orderType: 'market',
    candles: [],
    tickers: new Map(),     // symbol -> { price, open, high, low, chg, vol }
    book: { bids: [], asks: [] },
    trades: [],
    marketFilter: '',
    bottomTab: 'open',
    chartReady: false,
  };

  const $ = (id) => document.getElementById(id);

  // ========== Утилиты ==========
  const base = (s) => s.replace(QUOTE, '');
  const pretty = (s) => base(s) + '/' + QUOTE;
  const priceDigits = (sym) => (DIGITS[base(sym)] || [2])[0];
  const qtyDigits = (sym) => (DIGITS[base(sym)] || [2, 4])[1];

  function fmt(v, d = 2) {
    if (!Number.isFinite(v)) return '—';
    return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtVol(v) {
    if (!Number.isFinite(v) || v === 0) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(2);
  }
  function timeStr(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function toast(msg, kind) {
    const t = $('x-toast');
    t.textContent = msg;
    t.className = 'xtoast show ' + (kind || '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = 'xtoast ' + (kind || ''); }, 2400);
  }

  // ========== Хранилище счёта ==========
  function loadAccount() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.balances && typeof s.balances.USDT === 'number') return s;
    } catch (e) { /* ignore */ }
    return { balances: { USDT: START_USDT }, open: [], history: [], seq: 1 };
  }
  let acc = loadAccount();
  function saveAccount() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(acc)); } catch (e) { /* ignore */ }
  }

  function bal(asset) { return acc.balances[asset] || 0; }
  function addBal(asset, delta) {
    acc.balances[asset] = (acc.balances[asset] || 0) + delta;
    if (Math.abs(acc.balances[asset]) < 1e-10) acc.balances[asset] = 0;
  }

  // ========== REST загрузчик с перебором доменов ==========
  async function fetchJson(pathWithQuery) {
    let lastErr;
    for (const host of REST_URLS) {
      try {
        const r = await fetch(host + pathWithQuery, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Нет связи с API биржи');
  }

  // ========== График ==========
  const chart = new CandleChart($('x-chart'), {
    bg: '#111111', grid: 'rgba(255,255,255,0.06)', text: '#8a8a8a',
    up: '#26c281', down: '#ff5a4f', maxCandles: 140,
  });
  chart.onHover = (c) => {
    const d = priceDigits(state.symbol);
    const src = c || state.candles[state.candles.length - 1];
    if (!src) { $('x-ohlc').innerHTML = ''; return; }
    const chg = ((src.close - src.open) / src.open) * 100;
    const chgCls = chg >= 0 ? 'up' : 'down';
    $('x-ohlc').innerHTML =
      `O <i>${fmt(src.open, d)}</i>` +
      `H <i>${fmt(src.high, d)}</i>` +
      `L <i>${fmt(src.low, d)}</i>` +
      `C <i>${fmt(src.close, d)}</i>` +
      `<i class="${chgCls}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</i>`;
  };

  function setChartStatus(msg) {
    const el = $('x-chart-status');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = msg;
  }
  function redrawChart() {
    chart.setData(state.candles, priceDigits(state.symbol));
    chart.onHover(null);
  }

  async function loadCandles() {
    state.candles = [];
    state.chartReady = false;
    setChartStatus('Загрузка графика…');
    redrawChart();
    const sym = state.symbol;
    const tf = state.tf;
    try {
      const rows = await fetchJson(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${MAX_CANDLES}`);
      if (sym !== state.symbol || tf !== state.tf) return;    // юзер уже переключил
      state.candles = rows.map((k) => ({
        time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      }));
      state.chartReady = true;
      setChartStatus(null);
      redrawChart();
    } catch (e) {
      setChartStatus('Не удалось загрузить график. Проверьте доступ к api.binance.com.');
      // eslint-disable-next-line no-console
      console.warn('klines', e);
    }
  }

  function pushKlineUpdate(k) {
    // k = { t: openTime, T: closeTime, s, i, o, h, l, c, v, x: isClosed }
    const candle = { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
    const last = state.candles[state.candles.length - 1];
    if (last && last.time === candle.time) Object.assign(last, candle);
    else if (!last || candle.time > last.time) {
      state.candles.push(candle);
      if (state.candles.length > MAX_CANDLES * 2) state.candles.splice(0, state.candles.length - MAX_CANDLES);
    }
    chart.update(candle);
  }

  // ========== Стакан ==========
  function renderBook() {
    const sym = state.symbol;
    const d = priceDigits(sym);
    const q = qtyDigits(sym);
    const asks = state.book.asks.slice(0, BOOK_ROWS);
    const bids = state.book.bids.slice(0, BOOK_ROWS);
    const maxQty = Math.max(
      ...asks.map((r) => +r[1]),
      ...bids.map((r) => +r[1]),
      1e-9,
    );
    const row = (side) => (r) => {
      const qty = +r[1];
      const px = +r[0];
      const sum = qty * px;
      return `<div class="xbook-row ${side}" data-px="${px}" style="--w:${((qty / maxQty) * 100).toFixed(1)}%">
          <span class="px">${fmt(px, d)}</span>
          <span>${fmt(qty, q)}</span>
          <span>${fmtVol(sum)}</span>
        </div>`;
    };
    // asks идут от худшей (сверху) к лучшей (внизу)
    $('x-asks').innerHTML = asks.slice().reverse().map(row('ask')).join('');
    $('x-bids').innerHTML = bids.map(row('bid')).join('');

    const bestAsk = asks[0] ? +asks[0][0] : null;
    const bestBid = bids[0] ? +bids[0][0] : null;
    if (bestAsk != null && bestBid != null) {
      const mid = (bestAsk + bestBid) / 2;
      const spreadPct = ((bestAsk - bestBid) / mid) * 100;
      $('x-mid').textContent = fmt(mid, d);
      const t = state.tickers.get(sym);
      const dir = t ? (t.price >= mid ? 'up' : 'down') : '';
      $('x-mid').className = dir;
      $('x-spread').textContent = `спред ${spreadPct.toFixed(3)}%`;
    } else {
      $('x-mid').textContent = '—';
      $('x-spread').textContent = '—';
    }
  }

  async function loadBook() {
    state.book = { bids: [], asks: [] };
    renderBook();
    const sym = state.symbol;
    try {
      const b = await fetchJson(`/api/v3/depth?symbol=${sym}&limit=20`);
      if (sym !== state.symbol) return;
      state.book = { bids: b.bids || [], asks: b.asks || [] };
      renderBook();
    } catch (e) { console.warn('depth', e); }
  }

  // ========== Лента сделок ==========
  function renderTrades() {
    const sym = state.symbol;
    const d = priceDigits(sym);
    const q = qtyDigits(sym);
    $('x-trades').innerHTML = state.trades.slice(0, TRADES_MAX).map((t) => `
      <div class="xtr-row ${t.m ? 'sell' : 'buy'}">
        <span class="px">${fmt(t.p, d)}</span>
        <span>${fmt(t.q, q)}</span>
        <span><small>${timeStr(t.T)}</small></span>
      </div>`).join('');
  }

  async function loadTrades() {
    state.trades = [];
    renderTrades();
    const sym = state.symbol;
    try {
      const rows = await fetchJson(`/api/v3/trades?symbol=${sym}&limit=${TRADES_MAX}`);
      if (sym !== state.symbol) return;
      state.trades = rows.reverse().map((r) => ({
        p: +r.price, q: +r.qty, T: r.time, m: r.isBuyerMaker,
      }));
      renderTrades();
    } catch (e) { console.warn('trades', e); }
  }

  // ========== Статистика тикера (24ч) ==========
  async function loadTickers() {
    const url = `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS))}`;
    try {
      const rows = await fetchJson(url);
      for (const r of rows) {
        state.tickers.set(r.symbol, {
          price: +r.lastPrice,
          open: +r.openPrice,
          high: +r.highPrice,
          low: +r.lowPrice,
          chg: +r.priceChangePercent,
          vol: +r.quoteVolume,
        });
      }
      renderMarkets();
      updateTopStats();
    } catch (e) {
      console.warn('tickers', e);
      $('x-markets').innerHTML = '<div class="xm-empty">Нет связи с биржей.<br>Проверьте доступ к api.binance.com и обновите страницу.</div>';
    }
  }

  // ========== Watchlist / топ-строка ==========
  function updateTopStats() {
    const sym = state.symbol;
    const t = state.tickers.get(sym);
    const d = priceDigits(sym);
    document.title = (t ? `${fmt(t.price, d)} · ` : '') + pretty(sym) + ' — InvestHouse';
    document.querySelectorAll('.xbase').forEach((el) => { el.textContent = base(sym); });
    $('x-sym-base').textContent = base(sym);
    if (!t) return;
    $('x-price').textContent = fmt(t.price, d);
    $('x-price').className = 'num ' + (t.price >= t.open ? 'up' : 'down');
    const chgCls = t.chg >= 0 ? 'up' : 'down';
    $('x-chg').textContent = `${t.chg >= 0 ? '+' : ''}${t.chg.toFixed(2)}%`;
    $('x-chg').className = 'num ' + chgCls;
    $('x-hi').textContent = fmt(t.high, d);
    $('x-lo').textContent = fmt(t.low, d);
    $('x-vol').textContent = fmtVol(t.vol) + ' ' + QUOTE;
  }

  function renderMarkets() {
    const q = state.marketFilter.toLowerCase();
    const rows = SYMBOLS
      .map((s) => ({ sym: s, ...(state.tickers.get(s) || {}) }))
      .filter((r) => !q || r.sym.toLowerCase().includes(q) || (NAMES[base(r.sym)] || '').toLowerCase().includes(q))
      .sort((a, b) => (b.vol || 0) - (a.vol || 0));
    if (!rows.length) {
      $('x-markets').innerHTML = '<div class="xm-empty">Ничего не найдено</div>';
      return;
    }
    $('x-markets').innerHTML = rows.map((r) => {
      const d = priceDigits(r.sym);
      const cls = r.sym === state.symbol ? ' active' : '';
      const chgCls = (r.chg || 0) >= 0 ? 'up' : 'down';
      return `<div class="xm-row${cls}" data-sym="${r.sym}">
        <span><b>${base(r.sym)}</b><small>${NAMES[base(r.sym)] || ''}</small></span>
        <span class="px">${fmt(r.price, d)}</span>
        <span class="chg ${chgCls}">${(r.chg || 0) >= 0 ? '+' : ''}${(r.chg || 0).toFixed(2)}%</span>
      </div>`;
    }).join('');
  }

  function updateMarketRow(sym, prevPrice) {
    const r = state.tickers.get(sym);
    if (!r) return;
    const row = document.querySelector(`.xm-row[data-sym="${sym}"]`);
    if (!row) return;
    const d = priceDigits(sym);
    const px = row.querySelector('.px');
    px.textContent = fmt(r.price, d);
    const chg = row.querySelector('.chg');
    chg.className = 'chg ' + ((r.chg || 0) >= 0 ? 'up' : 'down');
    chg.textContent = `${(r.chg || 0) >= 0 ? '+' : ''}${(r.chg || 0).toFixed(2)}%`;
    if (prevPrice != null && prevPrice !== r.price) {
      row.classList.remove('flash-up', 'flash-down');
      void row.offsetWidth;
      row.classList.add(r.price > prevPrice ? 'flash-up' : 'flash-down');
    }
  }

  // Селектор пары (dropdown в хедере)
  function renderPairList() {
    const q = ($('xpair-search').value || '').toLowerCase();
    const rows = SYMBOLS
      .map((s) => ({ sym: s, ...(state.tickers.get(s) || {}) }))
      .filter((r) => !q || r.sym.toLowerCase().includes(q) || (NAMES[base(r.sym)] || '').toLowerCase().includes(q))
      .sort((a, b) => (b.vol || 0) - (a.vol || 0));
    $('xpair-list').innerHTML = rows.map((r) => {
      const d = priceDigits(r.sym);
      const chgCls = (r.chg || 0) >= 0 ? 'up' : 'down';
      return `<div class="row${r.sym === state.symbol ? ' active' : ''}" data-sym="${r.sym}">
        <span><b>${base(r.sym)}</b><small>${NAMES[base(r.sym)] || ''}</small></span>
        <span>${fmt(r.price, d)}</span>
        <span class="chg ${chgCls}">${(r.chg || 0) >= 0 ? '+' : ''}${(r.chg || 0).toFixed(2)}%</span>
      </div>`;
    }).join('');
  }

  // ========== WebSocket ==========
  let perSymWs = null;
  let perSymAttempt = 0;
  function openPerSymStream() {
    if (perSymWs) { try { perSymWs.close(); } catch (e) { /* ignore */ } perSymWs = null; }
    const sym = state.symbol.toLowerCase();
    const tf = state.tf;
    const streams = [`${sym}@kline_${tf}`, `${sym}@depth20@100ms`, `${sym}@aggTrade`].join('/');
    const url = WS_URLS[perSymAttempt % WS_URLS.length] + `?streams=${streams}`;
    const ws = new WebSocket(url);
    perSymWs = ws;
    const bound = state.symbol;
    ws.onmessage = (ev) => {
      if (state.symbol !== bound) return;
      try {
        const msg = JSON.parse(ev.data);
        const s = msg.stream || '';
        const d = msg.data;
        if (!d) return;
        if (s.endsWith('@kline_' + state.tf)) {
          pushKlineUpdate(d.k);
        } else if (s.indexOf('@depth') > 0) {
          state.book = { bids: d.bids || [], asks: d.asks || [] };
          renderBook();
        } else if (s.endsWith('@aggTrade')) {
          state.trades.unshift({ p: +d.p, q: +d.q, T: d.T, m: !!d.m });
          if (state.trades.length > TRADES_MAX) state.trades.length = TRADES_MAX;
          renderTrades();
          applyTradeToTicker(d);
        }
      } catch (e) { /* ignore malformed */ }
    };
    ws.onclose = () => {
      if (perSymWs !== ws) return;
      perSymAttempt++;
      const delay = Math.min(1000 * 2 ** Math.min(perSymAttempt, 4), 10_000);
      setTimeout(() => { if (perSymWs === ws) openPerSymStream(); }, delay);
    };
    ws.onopen = () => { perSymAttempt = 0; };
  }

  // На каждой сделке дергаем тикер (мгновенная реакция, не ждём mini-ticker)
  function applyTradeToTicker(d) {
    const sym = d.s;
    const price = +d.p;
    const t = state.tickers.get(sym);
    if (t) {
      const prev = t.price;
      t.price = price;
      if (price > t.high) t.high = price;
      if (price < t.low) t.low = price;
      t.chg = ((price - t.open) / t.open) * 100;
      if (sym === state.symbol) updateTopStats();
      updateMarketRow(sym, prev);
    }
    tryFillLimits(sym, price);
  }

  // Глобальный поток миниттикеров — обновляет остальные пары
  let miniWs = null;
  let miniAttempt = 0;
  function openMiniStream() {
    if (miniWs) { try { miniWs.close(); } catch (e) { /* ignore */ } miniWs = null; }
    const url = WS_URLS[miniAttempt % WS_URLS.length] + '?streams=!miniTicker@arr';
    const ws = new WebSocket(url);
    miniWs = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const arr = msg.data || [];
        for (const r of arr) {
          if (!SYMBOLS.includes(r.s)) continue;
          const t = state.tickers.get(r.s) || { open: +r.o };
          const prev = t.price;
          t.price = +r.c; t.open = +r.o; t.high = +r.h; t.low = +r.l; t.vol = +r.q;
          t.chg = ((t.price - t.open) / t.open) * 100;
          state.tickers.set(r.s, t);
          updateMarketRow(r.s, prev);
          if (r.s === state.symbol) updateTopStats();
          tryFillLimits(r.s, t.price);
        }
      } catch (e) { /* ignore */ }
    };
    ws.onclose = () => {
      if (miniWs !== ws) return;
      miniAttempt++;
      const delay = Math.min(1000 * 2 ** Math.min(miniAttempt, 4), 10_000);
      setTimeout(() => { if (miniWs === ws) openMiniStream(); }, delay);
    };
    ws.onopen = () => { miniAttempt = 0; };
  }

  // ========== Торговля ==========
  function bestPrice(sym, side) {
    // side: 'buy' => ask, 'sell' => bid
    const book = sym === state.symbol ? state.book : null;
    if (book) {
      if (side === 'buy' && book.asks[0]) return +book.asks[0][0];
      if (side === 'sell' && book.bids[0]) return +book.bids[0][0];
    }
    const t = state.tickers.get(sym);
    return t ? t.price : null;
  }

  function executeMarket(side) {
    const sym = state.symbol;
    const baseAsset = base(sym);
    const price = bestPrice(sym, side);
    if (!price) return toast('Нет цены — подождите подключения к бирже', 'err');
    if (side === 'buy') {
      const usdt = +$('x-buy-amt').value;
      if (!(usdt > 0)) return toast('Укажите сумму в USDT', 'err');
      if (usdt > bal(QUOTE) + 1e-9) return toast('Недостаточно USDT', 'err');
      const qty = (usdt * (1 - FEE)) / price;
      addBal(QUOTE, -usdt);
      addBal(baseAsset, qty);
      recordFill({ side, type: 'market', symbol: sym, price, qty, cost: usdt, fee: usdt * FEE });
      toast(`Куплено ${fmt(qty, qtyDigits(sym))} ${baseAsset} по ${fmt(price, priceDigits(sym))}`, 'ok');
    } else {
      const qty = +$('x-sell-amt').value;
      if (!(qty > 0)) return toast('Укажите количество', 'err');
      if (qty > bal(baseAsset) + 1e-12) return toast(`Недостаточно ${baseAsset}`, 'err');
      const gross = qty * price;
      const net = gross * (1 - FEE);
      addBal(baseAsset, -qty);
      addBal(QUOTE, net);
      recordFill({ side, type: 'market', symbol: sym, price, qty, cost: gross, fee: gross * FEE });
      toast(`Продано ${fmt(qty, qtyDigits(sym))} ${baseAsset} по ${fmt(price, priceDigits(sym))}`, 'ok');
    }
    saveAccount();
    renderWallet();
    renderBottom();
  }

  function placeLimit(side) {
    const sym = state.symbol;
    const baseAsset = base(sym);
    const t = state.tickers.get(sym);
    const market = t ? t.price : bestPrice(sym, side);
    if (side === 'buy') {
      const price = +$('x-buy-price').value;
      const usdt = +$('x-buy-amt').value;
      if (!(price > 0) || !(usdt > 0)) return toast('Заполните цену и сумму', 'err');
      if (market && price > market * 2) return toast('Цена сильно выше рынка — проверьте значение', 'err');
      if (usdt > bal(QUOTE) + 1e-9) return toast('Недостаточно USDT', 'err');
      addBal(QUOTE, -usdt);                              // зарезервировано
      const qty = (usdt * (1 - FEE)) / price;
      acc.open.unshift({
        id: acc.seq++, symbol: sym, side: 'buy', type: 'limit',
        price, qty, cost: usdt, placedAt: Date.now(),
      });
      toast(`Лимитный ордер на покупку ${fmt(qty, qtyDigits(sym))} ${baseAsset} по ${fmt(price, priceDigits(sym))}`, 'ok');
    } else {
      const price = +$('x-sell-price').value;
      const qty = +$('x-sell-amt').value;
      if (!(price > 0) || !(qty > 0)) return toast('Заполните цену и количество', 'err');
      if (market && price < market / 2) return toast('Цена сильно ниже рынка — проверьте значение', 'err');
      if (qty > bal(baseAsset) + 1e-12) return toast(`Недостаточно ${baseAsset}`, 'err');
      addBal(baseAsset, -qty);
      acc.open.unshift({
        id: acc.seq++, symbol: sym, side: 'sell', type: 'limit',
        price, qty, cost: qty * price, placedAt: Date.now(),
      });
      toast(`Лимитный ордер на продажу ${fmt(qty, qtyDigits(sym))} ${baseAsset} по ${fmt(price, priceDigits(sym))}`, 'ok');
    }
    saveAccount();
    renderWallet();
    renderBottom();
  }

  function recordFill(o) {
    acc.history.unshift({ ...o, filledAt: Date.now() });
    acc.history = acc.history.slice(0, 200);
  }

  function cancelOrder(id) {
    const i = acc.open.findIndex((o) => o.id === id);
    if (i < 0) return;
    const o = acc.open[i];
    if (o.side === 'buy') addBal(QUOTE, o.cost);
    else addBal(base(o.symbol), o.qty);
    acc.open.splice(i, 1);
    saveAccount();
    renderWallet();
    renderBottom();
    toast('Ордер отменён');
  }

  function tryFillLimits(sym, price) {
    if (!acc.open.length) return;
    let changed = false;
    for (let i = acc.open.length - 1; i >= 0; i--) {
      const o = acc.open[i];
      if (o.symbol !== sym) continue;
      const hit = (o.side === 'buy' && price <= o.price) || (o.side === 'sell' && price >= o.price);
      if (!hit) continue;
      if (o.side === 'buy') addBal(base(sym), o.qty);
      else addBal(QUOTE, o.qty * o.price * (1 - FEE));
      recordFill({
        side: o.side, type: 'limit', symbol: sym,
        price: o.price, qty: o.qty, cost: o.cost, fee: o.cost * FEE,
      });
      acc.open.splice(i, 1);
      changed = true;
      toast(`Лимит исполнен: ${o.side === 'buy' ? 'куплено' : 'продано'} ${fmt(o.qty, qtyDigits(sym))} ${base(sym)} по ${fmt(o.price, priceDigits(sym))}`, 'ok');
    }
    if (changed) {
      saveAccount();
      renderWallet();
      renderBottom();
    }
  }

  // ========== Форма ордера ==========
  function updateRecv() {
    const sym = state.symbol;
    const d = priceDigits(sym);
    const q = qtyDigits(sym);
    const t = state.tickers.get(sym);
    const market = t ? t.price : 0;
    const buyPx = state.orderType === 'limit' ? +$('x-buy-price').value : (bestPrice(sym, 'buy') || market);
    const sellPx = state.orderType === 'limit' ? +$('x-sell-price').value : (bestPrice(sym, 'sell') || market);
    const buyAmt = +$('x-buy-amt').value || 0;
    const sellAmt = +$('x-sell-amt').value || 0;
    $('x-buy-recv').innerHTML = (buyPx > 0 ? fmt((buyAmt * (1 - FEE)) / buyPx, q) : '—') + ' <span class="xbase">' + base(sym) + '</span>';
    $('x-sell-recv').innerHTML = (sellPx > 0 ? fmt(sellAmt * sellPx * (1 - FEE), 2) : '—') + ' USDT';
  }

  function renderWallet() {
    const sym = state.symbol;
    const baseAsset = base(sym);
    $('x-bal-usdt').textContent = fmt(bal(QUOTE), 2) + ' USDT';
    $('x-bal-base').innerHTML = fmt(bal(baseAsset), qtyDigits(sym)) + ' <span class="xbase">' + baseAsset + '</span>';
    // Эквити: USDT + сумма активов * последняя цена + USDT в открытых лимитных ордерах
    let eq = bal(QUOTE);
    for (const [asset, qty] of Object.entries(acc.balances)) {
      if (asset === QUOTE || !qty) continue;
      const t = state.tickers.get(asset + QUOTE);
      if (t) eq += qty * t.price;
    }
    for (const o of acc.open) {
      if (o.side === 'buy') eq += o.cost;
      else {
        const t = state.tickers.get(o.symbol);
        if (t) eq += o.qty * t.price;
      }
    }
    $('x-equity').textContent = fmt(eq, 2) + ' USDT';
  }

  // ========== Нижняя панель ==========
  function renderBottom() {
    $('x-open-count').textContent = acc.open.length;
    const head = $('x-b-head');
    const body = $('x-b-body');
    if (state.bottomTab === 'open') {
      head.innerHTML = '<tr><th>Пара</th><th>Тип</th><th>Сторона</th><th>Цена</th><th>Объём</th><th>Сумма (USDT)</th><th>Время</th><th></th></tr>';
      body.innerHTML = acc.open.length ? acc.open.map((o) => {
        const d = priceDigits(o.symbol);
        const q = qtyDigits(o.symbol);
        return `<tr>
          <td><b>${pretty(o.symbol)}</b></td>
          <td><span class="type-tag">${o.type === 'limit' ? 'ЛИМИТ' : 'МАРКЕТ'}</span></td>
          <td><span class="side-tag ${o.side}">${o.side === 'buy' ? 'ПОКУПКА' : 'ПРОДАЖА'}</span></td>
          <td>${fmt(o.price, d)}</td>
          <td>${fmt(o.qty, q)}</td>
          <td>${fmt(o.cost, 2)}</td>
          <td>${new Date(o.placedAt).toLocaleString('ru-RU')}</td>
          <td><button class="cancel-btn" data-cancel="${o.id}">Отменить</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="8" class="xb-empty">Открытых ордеров нет. Выберите пару и нажмите «Купить» или «Продать».</td></tr>';
    } else if (state.bottomTab === 'history') {
      head.innerHTML = '<tr><th>Пара</th><th>Тип</th><th>Сторона</th><th>Цена</th><th>Объём</th><th>Сумма (USDT)</th><th>Комиссия</th><th>Время</th></tr>';
      body.innerHTML = acc.history.length ? acc.history.map((o) => {
        const d = priceDigits(o.symbol);
        const q = qtyDigits(o.symbol);
        return `<tr>
          <td><b>${pretty(o.symbol)}</b></td>
          <td><span class="type-tag">${o.type === 'limit' ? 'ЛИМИТ' : 'МАРКЕТ'}</span></td>
          <td><span class="side-tag ${o.side}">${o.side === 'buy' ? 'ПОКУПКА' : 'ПРОДАЖА'}</span></td>
          <td>${fmt(o.price, d)}</td>
          <td>${fmt(o.qty, q)}</td>
          <td>${fmt(o.cost, 2)}</td>
          <td>${fmt(o.fee || 0, 4)}</td>
          <td>${new Date(o.filledAt).toLocaleString('ru-RU')}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="8" class="xb-empty">История сделок пуста.</td></tr>';
    } else {
      head.innerHTML = '<tr><th>Актив</th><th>Баланс</th><th>Текущая цена</th><th>Стоимость (USDT)</th></tr>';
      const rows = Object.entries(acc.balances).filter(([, v]) => Math.abs(v) > 1e-10);
      body.innerHTML = rows.length ? rows.map(([asset, qty]) => {
        if (asset === QUOTE) {
          return `<tr><td><b>${asset}</b></td><td>${fmt(qty, 2)}</td><td>—</td><td>${fmt(qty, 2)}</td></tr>`;
        }
        const t = state.tickers.get(asset + QUOTE);
        const sym = asset + QUOTE;
        const d = priceDigits(sym);
        const q = qtyDigits(sym);
        const value = t ? qty * t.price : null;
        return `<tr>
          <td><b>${asset}</b> <small style="color:var(--muted)">${NAMES[asset] || ''}</small></td>
          <td>${fmt(qty, q)}</td>
          <td>${t ? fmt(t.price, d) : '—'}</td>
          <td>${value != null ? fmt(value, 2) : '—'}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="4" class="xb-empty">Балансов нет.</td></tr>';
    }
  }

  // ========== Переключение пары / таймфрейма ==========
  function selectSymbol(sym) {
    if (!SYMBOLS.includes(sym) || sym === state.symbol) {
      $('xpair-dd').hidden = true;
      $('xpair-btn').setAttribute('aria-expanded', 'false');
      return;
    }
    state.symbol = sym;
    history.replaceState(null, '', `?symbol=${sym}`);
    document.querySelectorAll('.xm-row').forEach((r) => r.classList.toggle('active', r.dataset.sym === sym));
    document.querySelectorAll('#xpair-list .row').forEach((r) => r.classList.toggle('active', r.dataset.sym === sym));
    $('xpair-dd').hidden = true;
    $('xpair-btn').setAttribute('aria-expanded', 'false');
    updateTopStats();
    // Сбрасываем значения формы под новую пару
    $('x-sell-amt').value = (10 ** -qtyDigits(sym)).toFixed(qtyDigits(sym));
    updateRecv();
    renderWallet();
    loadCandles();
    loadBook();
    loadTrades();
    openPerSymStream();
  }

  function selectTF(tf) {
    if (!INTERVALS[tf] || tf === state.tf) return;
    state.tf = tf;
    document.querySelectorAll('#x-tf button').forEach((b) => b.classList.toggle('active', b.dataset.tf === tf));
    loadCandles();
    openPerSymStream();
  }

  function setOrderType(type) {
    state.orderType = type;
    document.querySelectorAll('#x-form-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
    const limit = type === 'limit';
    $('x-buy-price-lbl').hidden = !limit;
    $('x-sell-price-lbl').hidden = !limit;
    if (limit) {
      const t = state.tickers.get(state.symbol);
      if (t) {
        if (!$('x-buy-price').value) $('x-buy-price').value = t.price.toFixed(priceDigits(state.symbol));
        if (!$('x-sell-price').value) $('x-sell-price').value = t.price.toFixed(priceDigits(state.symbol));
      }
    }
    updateRecv();
  }

  // ========== События ==========
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.xpair')) {
      $('xpair-dd').hidden = true;
      $('xpair-btn').setAttribute('aria-expanded', 'false');
    }
  });

  $('xpair-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !$('xpair-dd').hidden;
    $('xpair-dd').hidden = open;
    $('xpair-btn').setAttribute('aria-expanded', String(!open));
    if (!open) {
      renderPairList();
      $('xpair-search').value = '';
      $('xpair-search').focus();
    }
  });
  $('xpair-search').addEventListener('input', renderPairList);
  $('xpair-list').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) selectSymbol(row.dataset.sym);
  });

  $('x-market-search').addEventListener('input', (e) => {
    state.marketFilter = e.target.value;
    renderMarkets();
  });
  $('x-markets').addEventListener('click', (e) => {
    const row = e.target.closest('.xm-row');
    if (row) selectSymbol(row.dataset.sym);
  });

  $('x-tf').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) selectTF(btn.dataset.tf);
  });

  $('x-form-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) setOrderType(btn.dataset.type);
  });

  // Поле ввода цены/суммы — пересчёт
  ['x-buy-amt', 'x-sell-amt', 'x-buy-price', 'x-sell-price'].forEach((id) => {
    $(id).addEventListener('input', updateRecv);
  });

  // Процентные кнопки
  document.querySelectorAll('.xform-pct').forEach((grp) => {
    grp.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const p = +btn.dataset.p;
      if (grp.dataset.side === 'buy') {
        $('x-buy-amt').value = (bal(QUOTE) * p).toFixed(2);
      } else {
        const b = bal(base(state.symbol));
        $('x-sell-amt').value = (b * p).toFixed(qtyDigits(state.symbol));
      }
      updateRecv();
    });
  });

  // Клик по строке стакана — подставить цену в лимит
  $('x-asks').addEventListener('click', (e) => fillPriceFromBook(e, 'buy'));
  $('x-bids').addEventListener('click', (e) => fillPriceFromBook(e, 'sell'));
  function fillPriceFromBook(e, side) {
    const row = e.target.closest('.xbook-row');
    if (!row) return;
    if (state.orderType !== 'limit') setOrderType('limit');
    const d = priceDigits(state.symbol);
    const px = (+row.dataset.px).toFixed(d);
    ($(side === 'buy' ? 'x-buy-price' : 'x-sell-price')).value = px;
    updateRecv();
  }

  // Кнопки покупки / продажи
  $('x-buy').addEventListener('click', () => {
    if (state.orderType === 'market') executeMarket('buy');
    else placeLimit('buy');
  });
  $('x-sell').addEventListener('click', () => {
    if (state.orderType === 'market') executeMarket('sell');
    else placeLimit('sell');
  });

  // Нижние вкладки + отмена ордеров
  $('x-btabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.bottomTab = btn.dataset.tab;
    document.querySelectorAll('#x-btabs button').forEach((b) => b.classList.toggle('active', b === btn));
    renderBottom();
  });
  $('x-b-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cancel]');
    if (btn) cancelOrder(+btn.dataset.cancel);
  });

  // Сброс
  $('x-reset').addEventListener('click', () => {
    if (!confirm('Сбросить демо-счёт? Все балансы, открытые ордера и история будут удалены.')) return;
    acc = { balances: { USDT: START_USDT }, open: [], history: [], seq: 1 };
    saveAccount();
    renderWallet();
    renderBottom();
    toast('Демо-счёт сброшен', 'ok');
  });

  // ========== Инициализация ==========
  (async function init() {
    // Параметр ?symbol=
    const q = new URLSearchParams(location.search).get('symbol');
    if (q) {
      const up = q.toUpperCase();
      // Поддерживаем старые формы (BTCUSD) и новые (BTCUSDT)
      const candidates = [up, up.replace(/USD$/, 'USDT')];
      const found = candidates.find((s) => SYMBOLS.includes(s));
      if (found) state.symbol = found;
    }
    document.querySelectorAll('#x-tf button').forEach((b) => b.classList.toggle('active', b.dataset.tf === state.tf));
    document.querySelectorAll('.xbase').forEach((el) => { el.textContent = base(state.symbol); });
    $('x-sym-base').textContent = base(state.symbol);

    renderWallet();
    renderBottom();
    updateRecv();

    await loadTickers();
    updateTopStats();
    renderPairList();

    loadCandles();
    loadBook();
    loadTrades();

    openPerSymStream();
    openMiniStream();
  })();

  // На случай, если вкладка была в фоне и соединение дропнули
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (perSymWs && perSymWs.readyState !== 1) openPerSymStream();
    if (miniWs && miniWs.readyState !== 1) openMiniStream();
  });
})();
