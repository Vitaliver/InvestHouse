(function () {
  const { fmt, pretty, iconHtml, stream } = window.IH;
  const quotes = new Map();
  let group = 'all';
  const HERO = 'BTCUSD';

  document.getElementById('year').textContent = new Date().getFullYear();

  const heroChart = new CandleChart(document.getElementById('hero-chart'), {
    axes: false, crosshair: false, maxCandles: 60, bg: '#0d1b2a',
  });

  fetch(`/api/candles/${HERO}?limit=60`).then((r) => r.json()).then((c) => heroChart.setData(c, 2));

  // Таблица рынков
  const body = document.getElementById('markets-body');
  function renderTable() {
    const rows = [...quotes.values()].filter((q) => group === 'all' || q.group === group);
    body.innerHTML = rows.map((q) => `
      <tr data-symbol="${q.symbol}">
        <td><div class="asset">${iconHtml(q.symbol)}<div><b>${pretty(q.symbol)}</b><small>${q.name}</small></div></div></td>
        <td class="num"><b class="price">${fmt(q.price, q.digits)}</b></td>
        <td class="num hide-sm muted ba">${fmt(q.bid, q.digits)} / ${fmt(q.ask, q.digits)}</td>
        <td class="num"><span class="badge chg ${q.change >= 0 ? 'up' : 'down'}">${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}%</span></td>
        <td class="num hide-sm"><a class="btn btn-dark btn-sm" href="/terminal?symbol=${q.symbol}">Торговать</a></td>
      </tr>`).join('');
  }

  function updateRow(q, prev) {
    const tr = body.querySelector(`tr[data-symbol="${q.symbol}"]`);
    if (!tr) return;
    const price = tr.querySelector('.price');
    price.textContent = fmt(q.price, q.digits);
    tr.querySelector('.ba').textContent = `${fmt(q.bid, q.digits)} / ${fmt(q.ask, q.digits)}`;
    const chg = tr.querySelector('.chg');
    chg.className = `badge chg ${q.change >= 0 ? 'up' : 'down'}`;
    chg.textContent = `${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}%`;
    if (prev && prev.price !== q.price) {
      tr.classList.remove('flash-up', 'flash-down');
      void tr.offsetWidth;
      tr.classList.add(q.price > prev.price ? 'flash-up' : 'flash-down');
    }
  }

  document.getElementById('market-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#market-tabs .tab').forEach((t) => t.classList.toggle('active', t === btn));
    group = btn.dataset.group;
    renderTable();
  });

  // Бегущая строка
  function renderTicker() {
    const items = [...quotes.values()].map((q) => `
      <span class="ticker-item"><b>${pretty(q.symbol)}</b>${fmt(q.price, q.digits)}
      <span class="${q.change >= 0 ? 'up' : 'down'}">${q.change >= 0 ? '▲' : '▼'} ${Math.abs(q.change).toFixed(2)}%</span></span>`).join('');
    document.getElementById('ticker').innerHTML = items + items;
  }

  // Калькулятор
  const calc = {
    symbol: document.getElementById('calc-symbol'),
    amount: document.getElementById('calc-amount'),
    leverage: document.getElementById('calc-leverage'),
    move: document.getElementById('calc-move'),
    side: 'buy',
  };
  document.getElementById('calc-side').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    calc.side = b.dataset.side;
    document.querySelectorAll('#calc-side button').forEach((x) => x.classList.toggle('active', x === b));
    renderCalc();
  });
  ['input', 'change'].forEach((ev) =>
    [calc.symbol, calc.amount, calc.leverage, calc.move].forEach((el) => el.addEventListener(ev, renderCalc)));

  function renderCalc() {
    const q = quotes.get(calc.symbol.value);
    if (!q) return;
    const amount = Number(calc.amount.value) || 0;
    const lev = Number(calc.leverage.value) || 1;
    const price = calc.side === 'buy' ? q.ask : q.bid;
    const units = amount / price;
    const margin = amount / lev;
    const pl = amount * (Number(calc.move.value) || 0) / 100;
    document.getElementById('calc-price').textContent = fmt(price, q.digits);
    document.getElementById('calc-size').textContent = `${fmt(units, units < 10 ? 4 : 2)} ${window.IH.base(q.symbol)}`;
    document.getElementById('calc-margin').textContent = `${fmt(margin)} USD`;
    const plEl = document.getElementById('calc-pl');
    plEl.textContent = `${pl >= 0 ? '+' : ''}${fmt(pl)} USD`;
  }

  let first = true;
  stream((updates) => {
    for (const q of updates) {
      const prev = quotes.get(q.symbol);
      quotes.set(q.symbol, q);
      if (!first) updateRow(q, prev);
      if (q.symbol === HERO) {
        document.getElementById('hero-price').textContent = fmt(q.price, q.digits);
        document.getElementById('hero-bid').textContent = fmt(q.bid, q.digits);
        document.getElementById('hero-ask').textContent = fmt(q.ask, q.digits);
        if (q.candle) heroChart.update(q.candle);
      }
    }
    if (first) {
      first = false;
      renderTable();
      renderTicker();
      document.getElementById('stat-count').textContent = `${quotes.size}+`;
      calc.symbol.innerHTML = [...quotes.values()].map((q) => `<option value="${q.symbol}">${pretty(q.symbol)}</option>`).join('');
    }
    renderCalc();
  });

  // Обновляем бегущую строку раз в 10 секунд
  setInterval(() => quotes.size && renderTicker(), 10000);
})();
