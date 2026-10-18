// Дашборд сигналов InvestHouse.
// Авторизация обязательна (Supabase); пары + подключение Telegram — через наш API.
// Живая лента сигналов — через Supabase Realtime (postgres_changes на public.signals).

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const PAIRS = []; // заполнится из /api/signals/symbols
  const state = {
    user: null,
    profile: { symbols: [], telegramLinked: false },
    telegramEnabled: false,
    botUsername: null,
    tab: 'open',
    openSignals: [],
    recentSignals: [],
    statsDays: 30,
  };

  function toast(msg, kind) {
    const t = $('sg-toast');
    t.textContent = msg;
    t.className = 'sg-toast show ' + (kind || '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = 'sg-toast ' + (kind || ''); }, 2600);
  }

  function fmtPrice(sym, v) {
    if (v == null || !Number.isFinite(+v)) return '—';
    const base = (sym || '').replace(/USDT$/, '');
    const d = { BTC: 2, ETH: 2, SOL: 3, BNB: 2, XRP: 4, DOGE: 5, ADA: 4, LTC: 2, LINK: 3, DOT: 3, AVAX: 3, ATOM: 3, SHIB: 8 }[base] ?? 2;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtR(v) {
    if (v == null || !Number.isFinite(+v)) return '—';
    const n = Number(v);
    return (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60) return 'только что';
    if (diff < 3600) return Math.floor(diff / 60) + ' мин назад';
    if (diff < 86400) return Math.floor(diff / 3600) + ' ч назад';
    return d.toLocaleDateString('ru-RU') + ', ' + d.toTimeString().slice(0, 5);
  }

  // ========== API helpers ==========
  async function authHeaders() {
    const sb = await IH.getSupabase();
    if (!sb) return {};
    const { data } = await sb.auth.getSession();
    const t = data.session && data.session.access_token;
    return t ? { Authorization: 'Bearer ' + t } : {};
  }
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}), ...(await authHeaders()) };
    const res = await fetch(path, { ...opts, headers });
    if (!res.ok) {
      let err;
      try { err = (await res.json()).error; } catch (e) { /* ignore */ }
      throw new Error(err || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ========== Загрузка данных ==========
  async function loadSymbols() {
    const { symbols } = await api('/api/signals/symbols');
    PAIRS.length = 0;
    PAIRS.push(...symbols);
  }
  async function loadProfile() {
    const r = await api('/api/me/profile');
    state.user = r.user;
    state.profile = r.profile;
    state.telegramEnabled = r.telegram && r.telegram.enabled;
    state.botUsername = r.telegram && r.telegram.botUsername;
    renderUser(); renderPairs(); renderTelegram();
  }
  async function loadOpen() {
    const r = await api('/api/signals/open');
    state.openSignals = r.rows || [];
    if (state.tab === 'open') renderFeed();
    $('sg-open-count').textContent = state.openSignals.length;
  }
  async function loadRecent(limit = 50, outcome) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (outcome) q.set('outcome', outcome);
    const r = await api('/api/signals/recent?' + q);
    state.recentSignals = r.rows || [];
    renderFeed();
  }
  async function loadStats() {
    const s = await api('/api/signals/stats?days=' + state.statsDays);
    renderStats(s);
    // Короткая сводка в хедере — всегда 30 дней
    if (state.statsDays === 30) renderHeadStats(s);
    else {
      // отдельно подтягиваем 30-дневную статистику для хедера
      const h = await api('/api/signals/stats?days=30');
      renderHeadStats(h);
    }
  }

  // ========== Рендер ==========
  function renderUser() {
    if (!state.user) return;
    const email = state.user.email || 'аккаунт';
    $('sg-user').hidden = false;
    $('sg-user-avatar').textContent = (email[0] || '?').toUpperCase();
    $('sg-user-email').textContent = email;
    $('sg-user-email-full').textContent = email;
  }

  function renderPairs() {
    const picked = new Set(state.profile.symbols || []);
    const html = PAIRS.map((s) => {
      const base = s.replace(/USDT$/, '');
      const on = picked.has(s);
      return `<button type="button" class="sg-pair${on ? ' on' : ''}" data-sym="${s}">${base}</button>`;
    }).join('');
    $('sg-pairs').innerHTML = html || '<div class="sg-sub">Нет пар.</div>';
    $('sg-save-pairs').hidden = true;
  }

  function renderTelegram() {
    $('sg-tg-off').hidden = true;
    $('sg-tg-code').hidden = true;
    $('sg-tg-on').hidden = true;
    if (!state.telegramEnabled) {
      $('sg-tg-sub').textContent = 'Telegram-доставка не настроена на сервере.';
      return;
    }
    if (state.profile.telegramLinked) {
      $('sg-tg-on').hidden = false;
      $('sg-tg-sub').textContent = 'Чат подключён. Сигналы приходят в лс.';
    } else {
      $('sg-tg-off').hidden = false;
      $('sg-tg-sub').textContent = 'Подключите чат — сигналы будут приходить в лс.';
    }
  }

  function renderFeed() {
    const rows = state.tab === 'open' ? state.openSignals :
                 state.tab === 'recent' ? state.recentSignals :
                 state.recentSignals.filter((r) => r.outcome !== 'open');
    if (!rows.length) {
      const msg = state.tab === 'open'
        ? 'Пока нет открытых сигналов. Как только движок найдёт сетап, он появится здесь и уйдёт в Telegram подписчикам.'
        : 'Истории пока нет. Первые сигналы появятся на закрытиях ближайших свечей.';
      $('sg-feed').innerHTML = `<div class="sg-empty">${msg}</div>`;
      return;
    }
    $('sg-feed').innerHTML = rows.map(renderSignal).join('');
  }

  function renderSignal(s) {
    const sideClass = s.side === 'LONG' ? 'long' : 'short';
    const sideLabel = s.side === 'LONG' ? 'LONG' : 'SHORT';
    const sym = s.symbol;
    const base = sym.replace(/USDT$/, '');
    const outcome = s.outcome || 'open';
    const outcomeLabel = { open: 'Открыт', target: 'Цель', stop: 'Стоп', timeout: 'Таймаут', manual: 'Закрыт' }[outcome] || outcome;
    const r = s.r_multiple;
    const rClass = outcome === 'target' ? 'up' : outcome === 'stop' ? 'down' : (r != null && +r >= 0 ? 'up' : 'down');
    const extra = outcome === 'open'
      ? ''
      : `<div><span>Выход</span><b>${fmtPrice(sym, s.exit_price)}</b></div>
         <div><span>Результат</span><b class="${rClass}">${fmtR(r)}</b></div>`;
    return `
      <div class="sg-sig ${outcome !== 'open' ? 'sg-sig-closed' : ''}">
        <div style="display:grid;gap:10px;min-width:0">
          <div class="sg-sig-head">
            <span class="sg-sig-side ${sideClass}">${sideLabel}</span>
            <span class="sg-sig-sym">${base}/USDT</span>
            <span class="sg-sig-outcome ${outcome}">${outcomeLabel}</span>
            <span class="sg-sig-time">${fmtTime(s.entered_at)}</span>
          </div>
          <div class="sg-sig-grid">
            <div><span>Вход</span><b>${fmtPrice(sym, s.entry)}</b></div>
            <div><span>Стоп</span><b class="down">${fmtPrice(sym, s.stop)}</b></div>
            <div><span>Цель</span><b class="up">${fmtPrice(sym, s.target)}</b></div>
            <div><span>R:R</span><b>${Number(s.rr || 1.5).toFixed(2)}</b></div>
            ${extra}
          </div>
        </div>
      </div>
    `;
  }

  function renderStats(s) {
    const pct = (s.winRate * 100).toFixed(1) + '%';
    $('sg-s-count').textContent = s.count;
    $('sg-s-wins').textContent = s.wins;
    $('sg-s-loss').textContent = s.losses;
    $('sg-s-wr').textContent = s.count ? pct : '—';
    $('sg-s-wr').className = s.winRate >= 0.55 ? 'up' : s.winRate >= 0.45 ? '' : 'down';
    $('sg-s-ar').textContent = s.count ? fmtR(s.avgR) : '—';
    $('sg-s-ar').className = s.avgR >= 0 ? 'up' : 'down';
    $('sg-s-tr').textContent = s.count ? fmtR(s.totalR) : '—';
    $('sg-s-tr').className = s.totalR >= 0 ? 'up' : 'down';
  }
  function renderHeadStats(s) {
    $('sg-wr').textContent = s.count ? (s.winRate * 100).toFixed(1) + '%' : '—';
    $('sg-wr').className = s.winRate >= 0.55 ? 'up' : '';
    $('sg-ar').textContent = s.count ? fmtR(s.avgR) : '—';
    $('sg-ar').className = s.avgR >= 0 ? 'up' : 'down';
    $('sg-tr').textContent = s.count ? fmtR(s.totalR) : '—';
    $('sg-tr').className = s.totalR >= 0 ? 'up' : 'down';
  }

  // ========== Supabase Realtime ==========
  async function startRealtime() {
    const sb = await IH.getSupabase();
    if (!sb) return;
    sb.channel('signals-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals' }, (payload) => {
        const row = payload.new;
        state.openSignals.unshift(row);
        if (state.tab === 'open') renderFeed();
        $('sg-open-count').textContent = state.openSignals.length;
        // мягкое уведомление
        const base = row.symbol.replace(/USDT$/, '');
        toast(`Новый сигнал: ${row.side} ${base}/USDT`, 'ok');
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'signals' }, (payload) => {
        const row = payload.new;
        state.openSignals = state.openSignals.filter((r) => r.id !== row.id);
        state.recentSignals = [row, ...state.recentSignals.filter((r) => r.id !== row.id)].slice(0, 100);
        renderFeed();
        $('sg-open-count').textContent = state.openSignals.length;
        loadStats().catch(() => {});
      })
      .subscribe();
  }

  // ========== Обработчики ==========
  // Таб
  $('sg-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    state.tab = b.dataset.tab;
    document.querySelectorAll('#sg-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    if (state.tab === 'open') loadOpen().catch((e) => toast(e.message, 'err'));
    else loadRecent(50).catch((e) => toast(e.message, 'err'));
  });

  // Пары — переключение
  $('sg-pairs').addEventListener('click', (e) => {
    const b = e.target.closest('.sg-pair'); if (!b) return;
    const sym = b.dataset.sym;
    const picked = new Set(state.profile.symbols || []);
    if (picked.has(sym)) picked.delete(sym); else picked.add(sym);
    state.profile.symbols = [...picked];
    renderPairs();
    $('sg-save-pairs').hidden = false;
  });
  $('sg-save-pairs').addEventListener('click', async () => {
    try {
      const r = await api('/api/me/profile/symbols', {
        method: 'POST',
        body: JSON.stringify({ symbols: state.profile.symbols }),
      });
      state.profile.symbols = r.symbols || [];
      renderPairs();
      toast('Подписки обновлены', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  // Telegram
  $('sg-tg-link').addEventListener('click', async () => {
    try {
      const r = await api('/api/me/telegram/link', { method: 'POST' });
      $('sg-tg-off').hidden = true;
      $('sg-tg-code').hidden = false;
      $('sg-tg-start').textContent = '/start ' + r.code;
      if (r.deepLink) {
        const a = $('sg-tg-link-url');
        a.href = r.deepLink;
        a.textContent = '@' + (r.botUsername || 'bot');
      }
    } catch (e) { toast(e.message, 'err'); }
  });
  $('sg-tg-cancel').addEventListener('click', () => renderTelegram());
  $('sg-tg-unlink').addEventListener('click', async () => {
    if (!confirm('Отключить Telegram? Сигналы перестанут приходить в лс.')) return;
    try {
      await api('/api/me/telegram/unlink', { method: 'POST' });
      state.profile.telegramLinked = false;
      renderTelegram();
      toast('Telegram отключён', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  // Статистика
  $('sg-stat-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]'); if (!b) return;
    state.statsDays = Number(b.dataset.days);
    document.querySelectorAll('#sg-stat-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    loadStats().catch((e) => toast(e.message, 'err'));
  });

  // Меню пользователя
  function closeUserMenu() {
    $('sg-user-menu').hidden = true;
    $('sg-user-trigger').setAttribute('aria-expanded', 'false');
  }
  $('sg-user-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('sg-user-menu');
    const open = menu.hidden;
    menu.hidden = !open;
    $('sg-user-trigger').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#sg-user')) closeUserMenu();
  });
  $('sg-logout').addEventListener('click', (e) => { e.stopPropagation(); closeUserMenu(); IH.signOut(); });

  // ========== Инициализация ==========
  (async function init() {
    const user = await IH.requireAuth();
    if (!user) return;
    try {
      await loadSymbols();
      await loadProfile();
      await Promise.all([loadOpen(), loadRecent(50), loadStats()]);
      await startRealtime();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('init error:', e);
      toast(e.message || 'Ошибка загрузки', 'err');
    }
  })();
})();
