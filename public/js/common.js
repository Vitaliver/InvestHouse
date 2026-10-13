// Общие утилиты для лендинга и терминала
(function (global) {
  const COLORS = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#14b8a6', BNB: '#f0b90b', XRP: '#23292f', DOGE: '#c2a633',
    EUR: '#2563eb', GBP: '#7c3aed', USD: '#16a34a', AUD: '#0891b2', XAU: '#d4a017', XAG: '#94a3b8',
  };

  function fmt(v, digits = 2) {
    return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function money(v) {
    return fmt(v, 2) + ' USD';
  }

  function pretty(symbol) {
    return symbol.length === 6 ? symbol.slice(0, 3) + '/' + symbol.slice(3) : symbol.replace('USD', '/USD');
  }

  function base(symbol) {
    return symbol.replace(/USD$/, '') || symbol.slice(0, 3);
  }

  function iconHtml(symbol) {
    const b = base(symbol).slice(0, 4);
    const c = COLORS[b] || COLORS[symbol.slice(0, 3)] || '#135a5b';
    return `<span class="asset-icon" style="background:${c}">${b.slice(0, 3)}</span>`;
  }

  // Подписка на поток котировок с автопереподключением (EventSource делает это сам)
  function stream(onUpdate) {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => onUpdate(JSON.parse(e.data));
    return es;
  }

  global.IH = { fmt, money, pretty, base, iconHtml, stream };
})(window);
