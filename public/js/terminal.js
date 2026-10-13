// Торговый терминал: демо-счёт хранится в localStorage браузера
(function () {
  const { fmt, money, pretty, stream } = window.IH;
  const STORE = 'investhouse.demo.v1';
  const START_BALANCE = 10000;

  const quotes = new Map();
  let symbol = new URLSearchParams(location.search).get('symbol') || 'BTCUSD';
  let tf = 1;
  let raw = [];
  let tab = 'open';
  let filter = { group: 'all', q: '' };

  const $ = (id) => document.getElementById(id);

  // ---- Состояние счёта ----
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (s && typeof s.balance === 'number') return s;
    } catch (e) { /* хранилище недоступно */ }
    return { balance: START_BALANCE, positions: [], history: [], seq: 1 };
  }
  let acc = load();
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(acc)); } catch (e) { /* ignore */ }
  }

  function pnl(p) {
    const q = quotes.get(p.symbol);
    if (!q) return 0;
    const exit = p.side === 'buy' ? q.bid : q.ask;
    return (exit - p.openPrice) * p.units * (p.side === 'buy' ? 1 : -1);
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---- Торговля ----
  function open(side) {
    const q = quotes.get(symbol);
    if (!q) return;
    const amount = Number($('o-amount').value);
    const lev = Number($('o-lev').value);
    if (!(amount > 0)) return toast('Укажите сумму');
    const used = acc.positions.reduce((s, p) => s + p.margin, 0);
    const equity = acc.balance + acc.positions.reduce((s, p) => s + pnl(p), 0);
    if (amount > equity - used) return toast('Недостаточно свободных средств');
    const price = side === 'buy' ? q.ask : q.bid;
    acc.positions.unshift({
      id: acc.seq++, symbol, side, lev, margin: amount,
      units: (amount * lev) / price, openPrice: price, digits: q.digits, openedAt: Date.now(),
    });
    save();
    toast(`${side === 'buy' ? 'Покупка' : 'Продажа'} ${pretty(symbol)} по ${fmt(price, q.digits)}`);
    renderPositions();
  }

  function close(id, reason) {
    const i = acc.positions.findIndex((p) => p.id === id);
    if (i < 0) return;
    const p = acc.positions[i];
    const q = quotes.get(p.symbol);
    const profit = pnl(p);
    acc.balance += profit;
    acc.positions.splice(i, 1);
    acc.history.unshift({ ...p, closePrice: p.side === 'buy' ? q.bid : q.ask, profit, closedAt: Date.now(), reason });
    acc.history = acc.history.slice(0, 100);
    save();
    toast(`${reason || 'Позиция закрыта'}: ${profit >= 0 ? '+' : ''}${fmt(profit)} USD`);
    renderPositions();
  }

  // ---- Отрисовка ----
  function renderStats() {
    const margin = acc.positions.reduce((s, p) => s + p.margin, 0);
    const pl = acc.positions.reduce((s, p) => s + pnl(p), 0);
    const equity = acc.balance + pl;
    $('s-balance').textContent = money(acc.balance);
    $('s-equity').textContent = money(equity);
    $('s-margin').textContent = money(margin);
    $('s-free').textContent = money(equity - margin);
    $('s-level').textContent = margin ? fmt((equity / margin) * 100) + '%' : '—';
    const plEl = $('s-pl');
    plEl.textContent = `${pl >= 0 ? '+' : ''}${fmt(pl)} USD`;
    plEl.className = pl > 0 ? 'up' : pl < 0 ? 'down' : '';

    // Стоп-аут: при уровне маржи ниже 50% закрываем самую убыточную позицию
    if (margin && equity / margin < 0.5) {
      const worst = acc.positions.reduce((a, b) => (pnl(a) < pnl(b) ? a : b));
      close(worst.id, 'Стоп-аут');
    }
  }

  function renderWatch() {
    const rows = [...quotes.values()].filter((q) =>
      (filter.group === 'all' || q.group === filter.group) &&
      (q.symbol + q.name).toLowerCase().includes(filter.q.toLowerCase()));
    $('watch').innerHTML = rows.map((q) => `
      <div class="watch-row ${q.symbol === symbol ? 'active' : ''}" data-symbol="${q.symbol}">
        <span><b>${pretty(q.symbol)}</b><small class="${q.change >= 0 ? 'up' : 'down'}">${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}%</small></span>
        <span class="down" data-f="bid">${fmt(q.bid, q.digits)}</span>
        <span class="up" data-f="ask">${fmt(q.ask, q.digits)}</span>
      </div>`).join('');
  }

  function updateWatch(q) {
    const row = document.querySelector(`.watch-row[data-symbol="${q.symbol}"]`);
    if (!row) return;
    row.querySelector('[data-f="bid"]').textContent = fmt(q.bid, q.digits);
    row.querySelector('[data-f="ask"]').textContent = fmt(q.ask, q.digits);
    const small = row.querySelector('small');
    small.className = q.change >= 0 ? 'up' : 'down';
    small.textContent = `${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}%`;
  }

  function renderOrder() {
    const q = quotes.get(symbol);
    if (!q) return;
    $('o-bid').textContent = fmt(q.bid, q.digits);
    $('o-ask').textContent = fmt(q.ask, q.digits);
    const notional = (Number($('o-amount').value) || 0) * Number($('o-lev').value);
    const units = notional / q.price;
    $('o-size').textContent = `${fmt(units, units < 10 ? 4 : 2)} ${window.IH.base(symbol)} · ${fmt(notional)} USD`;
  }

  function renderPositions() {
    $('open-count').textContent = acc.positions.length;
    if (tab === 'open') {
      $('p-head').innerHTML = '<tr><th>Инструмент</th><th>Тип</th><th>Объём</th><th>Плечо</th><th>Цена открытия</th><th>Текущая</th><th>Маржа</th><th>P/L</th><th></th></tr>';
      $('p-body').innerHTML = acc.positions.length ? acc.positions.map((p) => {
        const q = quotes.get(p.symbol);
        const cur = q ? (p.side === 'buy' ? q.bid : q.ask) : p.openPrice;
        const pl = pnl(p);
        return `<tr>
          <td><b>${pretty(p.symbol)}</b></td>
          <td><span class="side-tag ${p.side}">${p.side.toUpperCase()}</span></td>
          <td>${fmt(p.units, p.units < 10 ? 4 : 2)}</td>
          <td>1:${p.lev}</td>
          <td>${fmt(p.openPrice, p.digits)}</td>
          <td>${fmt(cur, p.digits)}</td>
          <td>${fmt(p.margin)}</td>
          <td class="${pl >= 0 ? 'up' : 'down'}"><b>${pl >= 0 ? '+' : ''}${fmt(pl)}</b></td>
          <td><button class="close-btn" data-close="${p.id}">Закрыть</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="9" class="empty">Нет открытых позиций. Выберите актив и нажмите BUY или SELL.</td></tr>';
    } else {
      $('p-head').innerHTML = '<tr><th>Инструмент</th><th>Тип</th><th>Объём</th><th>Открытие</th><th>Закрытие</th><th>Время</th><th>Результат</th></tr>';
      $('p-body').innerHTML = acc.history.length ? acc.history.map((p) => `<tr>
          <td><b>${pretty(p.symbol)}</b></td>
          <td><span class="side-tag ${p.side}">${p.side.toUpperCase()}</span></td>
          <td>${fmt(p.units, p.units < 10 ? 4 : 2)}</td>
          <td>${fmt(p.openPrice, p.digits)}</td>
          <td>${fmt(p.closePrice, p.digits)}</td>
          <td>${new Date(p.closedAt).toLocaleString('ru-RU')}</td>
          <td class="${p.profit >= 0 ? 'up' : 'down'}"><b>${p.profit >= 0 ? '+' : ''}${fmt(p.profit)}</b></td>
        </tr>`).join('') : '<tr><td colspan="7" class="empty">История сделок пуста.</td></tr>';
    }
  }

  // ---- График ----
  const chart = new CandleChart($('chart'), { bg: '#0f1e2e', grid: 'rgba(255,255,255,0.04)' });
  chart.onHover = (c) => {
    const q = quotes.get(symbol);
    const d = q ? q.digits : 2;
    const src = c || chart.candles[chart.candles.length - 1];
    if (!src) return;
    $('c-ohlc').innerHTML = ['Open', 'High', 'Low', 'Close']
      .map((k) => `${k[0]} <i>${src[k.toLowerCase()].toFixed(d)}</i>`).join('');
  };

  function redrawChart() {
    const q = quotes.get(symbol);
    chart.setData(CandleChart.aggregate(raw, tf), q ? q.digits : 2);
    chart.onHover(null);
  }

  async function selectSymbol(s) {
    symbol = s;
    history.replaceState(null, '', `?symbol=${s}`);
    $('c-symbol').textContent = pretty(s);
    document.title = `${pretty(s)} — InvestHouse`;
    document.querySelectorAll('.watch-row').forEach((r) => r.classList.toggle('active', r.dataset.symbol === s));
    renderOrder();
    const res = await fetch(`/api/candles/${s}?limit=600`);
    if (!res.ok) return;
    if (s !== symbol) return;
    raw = await res.json();
    redrawChart();
  }

  // ---- События ----
  $('watch').addEventListener('click', (e) => {
    const row = e.target.closest('.watch-row');
    if (row) selectSymbol(row.dataset.symbol);
  });
  $('group').addEventListener('change', (e) => { filter.group = e.target.value; renderWatch(); });
  $('search').addEventListener('input', (e) => { filter.q = e.target.value; renderWatch(); });
  $('o-buy').addEventListener('click', () => open('buy'));
  $('o-sell').addEventListener('click', () => open('sell'));
  $('o-amount').addEventListener('input', renderOrder);
  $('o-lev').addEventListener('change', renderOrder);
  $('p-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-close]');
    if (b) close(Number(b.dataset.close));
  });
  $('btabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#btabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderPositions();
  });
  $('tf').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    tf = Number(b.dataset.tf);
    document.querySelectorAll('#tf button').forEach((x) => x.classList.toggle('active', x === b));
    redrawChart();
  });
  $('reset').addEventListener('click', () => {
    if (!confirm('Сбросить демо-счёт? Все позиции и история будут удалены.')) return;
    acc = { balance: START_BALANCE, positions: [], history: [], seq: 1 };
    save();
    renderPositions();
    renderStats();
    toast('Демо-счёт сброшен');
  });

  // ---- Поток котировок ----
  let first = true;
  stream((updates) => {
    for (const q of updates) {
      quotes.set(q.symbol, q);
      if (!first) updateWatch(q);
      if (q.symbol === symbol && q.candle && raw.length) {
        const last = raw[raw.length - 1];
        if (last.time === q.candle.time) Object.assign(last, q.candle);
        else if (q.candle.time > last.time) raw.push(q.candle);
        redrawChart();
      }
    }
    if (first) {
      first = false;
      if (!quotes.has(symbol)) symbol = 'BTCUSD';
      renderWatch();
      selectSymbol(symbol);
    }
    renderOrder();
    renderStats();
    if (tab === 'open') renderPositions();
  });

  renderPositions();
})();
