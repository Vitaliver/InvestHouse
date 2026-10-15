// Общие утилиты для всех страниц.
(function (global) {
  const COLORS = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#14b8a6', BNB: '#f0b90b', XRP: '#23292f', DOGE: '#c2a633',
    EUR: '#2563eb', GBP: '#7c3aed', USD: '#16a34a', AUD: '#0891b2', XAU: '#d4a017', XAG: '#94a3b8',
  };

  function fmt(v, digits = 2) {
    return Number(v).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function money(v) { return fmt(v, 2) + ' USD'; }
  function pretty(symbol) {
    return symbol.length === 6 ? symbol.slice(0, 3) + '/' + symbol.slice(3) : symbol.replace('USD', '/USD');
  }
  function base(symbol) { return symbol.replace(/USD$/, '') || symbol.slice(0, 3); }
  function iconHtml(symbol) {
    const b = base(symbol).slice(0, 4);
    const c = COLORS[b] || COLORS[symbol.slice(0, 3)] || '#135a5b';
    return `<span class="asset-icon" style="background:${c}">${b.slice(0, 3)}</span>`;
  }
  function stream(onUpdate) {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => onUpdate(JSON.parse(e.data));
    return es;
  }

  // ========== Supabase ==========
  // Клиент создаётся лениво: нужен загруженный /vendor/supabase.js и ключи с /api/config.
  let _configPromise = null;
  let _client = null;
  let _clientError = null;

  function loadConfig() {
    if (!_configPromise) {
      _configPromise = fetch('/api/config', { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => ({}));
    }
    return _configPromise;
  }

  async function getSupabase() {
    if (_client) return _client;
    if (_clientError) return null;
    const cfg = await loadConfig();
    if (!cfg || !cfg.supabase || !cfg.supabase.url || !cfg.supabase.anonKey) {
      _clientError = new Error('Supabase не настроен на сервере');
      return null;
    }
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      _clientError = new Error('Клиентская библиотека Supabase не загружена (vendor/supabase.js)');
      return null;
    }
    _client = global.supabase.createClient(cfg.supabase.url, cfg.supabase.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    return _client;
  }

  async function getSession() {
    const sb = await getSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session;
  }

  async function currentUser() {
    const s = await getSession();
    return s ? s.user : null;
  }

  async function requireAuth() {
    const sb = await getSupabase();
    if (!sb) {
      // Если Supabase не настроен — отправляем на /auth, там покажется баннер «не настроено».
      location.replace('/auth?next=' + encodeURIComponent(location.pathname + location.search));
      return null;
    }
    const { data } = await sb.auth.getSession();
    if (data.session) return data.session.user;
    location.replace('/auth?next=' + encodeURIComponent(location.pathname + location.search));
    return null;
  }

  async function signOut() {
    const sb = await getSupabase();
    if (sb) await sb.auth.signOut();
    location.replace('/');
  }

  global.IH = {
    fmt, money, pretty, base, iconHtml, stream,
    loadConfig, getSupabase, getSession, currentUser, requireAuth, signOut,
  };
})(window);
