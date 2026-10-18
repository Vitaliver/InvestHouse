'use strict';

// Telegram-бот для доставки сигналов в лс.
// Запускается если задан TG_BOT_TOKEN в env. Иначе — no-op.
//
// Поддерживает:
//   - long-polling (getUpdates) — не требует настройки webhook/домена
//   - команду /start <code> для привязки аккаунта
//   - рассылку сигналов и закрытий подписчикам пары

let supa = null;
let token = null;
let botUsername = null;
let polling = false;
let offset = 0;

async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!data.ok) {
    const e = new Error(`TG ${method}: ${data.description}`);
    e.code = data.error_code;
    throw e;
  }
  return data.result;
}

async function init({ supabase, botToken, log = console.log }) {
  if (!botToken) {
    log('[telegram] TG_BOT_TOKEN not set — доставка в лс отключена');
    return false;
  }
  if (!supabase) {
    log('[telegram] Supabase service-key не задан — привязка аккаунта невозможна');
    return false;
  }
  supa = supabase;
  token = botToken;

  try {
    const me = await tg('getMe');
    botUsername = me.username;
    log(`[telegram] connected as @${botUsername}`);
  } catch (e) {
    log('[telegram] getMe failed:', e.message);
    token = null;
    return false;
  }

  polling = true;
  poll(log);
  return true;
}

function enabled() { return !!token; }
function getBotUsername() { return botUsername; }

async function poll(log) {
  while (polling) {
    try {
      const updates = await tg('getUpdates', { offset: offset + 1, timeout: 25, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = Math.max(offset, u.update_id);
        await handleUpdate(u, log);
      }
    } catch (e) {
      log('[telegram] poll error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function handleUpdate(u, log) {
  const msg = u.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // /start <code> — привязать этот чат к аккаунту
  const m = text.match(/^\/start(?:\s+(.+))?$/i);
  if (m) {
    const code = (m[1] || '').trim();
    if (!code) {
      await sendMessage(chatId,
        'Привет! Я бот сигналов InvestHouse.\n\n' +
        'Чтобы получать сигналы в этот чат, зайдите на сайт, в разделе «Сигналы» ' +
        'нажмите «Подключить Telegram», скопируйте выданный код и отправьте мне команду:\n\n' +
        '`/start КОД`', { parse_mode: 'Markdown' });
      return;
    }
    const { data, error } = await supa
      .from('user_profile')
      .update({
        telegram_chat_id: chatId,
        telegram_link_code: null,
        telegram_linked_at: new Date().toISOString(),
      })
      .eq('telegram_link_code', code)
      .select()
      .single();
    if (error || !data) {
      await sendMessage(chatId, 'Код не найден или уже использован. Сгенерируйте новый на сайте.');
      log('[telegram] link failed, code:', code, 'error:', error && error.message);
      return;
    }
    await sendMessage(chatId,
      '✅ Аккаунт привязан. Сигналы по выбранным вами парам будут приходить сюда.',
      { parse_mode: 'Markdown' });
    log(`[telegram] linked user ${data.user_id} to chat ${chatId}`);
    return;
  }

  if (/^\/(help|start)\b/i.test(text)) {
    await sendMessage(chatId,
      'Команды:\n' +
      '/start <code> — привязать аккаунт\n' +
      '/pause — приостановить сигналы\n' +
      '/resume — возобновить');
    return;
  }

  if (text === '/pause' || text === '/resume') {
    const paused = text === '/pause';
    await supa.from('user_profile').update({ telegram_paused: paused }).eq('telegram_chat_id', chatId);
    await sendMessage(chatId, paused ? '⏸ Сигналы приостановлены. /resume чтобы включить.' : '▶ Сигналы снова идут.');
  }
}

async function sendMessage(chatId, text, extra = {}) {
  if (!token) return;
  try {
    await tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
  } catch (e) {
    if (e.code === 403) {
      // Юзер заблокировал бота — чистим привязку
      await supa.from('user_profile').update({ telegram_chat_id: null }).eq('telegram_chat_id', chatId);
    }
    // eslint-disable-next-line no-console
    console.warn('[telegram] send error:', e.message);
  }
}

// Формат сообщений сигнала
function fmtSignal(sig) {
  const dir = sig.side === 'LONG' ? '🟢 *LONG*' : '🔴 *SHORT*';
  const d = priceDigits(sig.symbol);
  const base = sig.symbol.replace(/USDT$/, '');
  return (
    `${dir} *${base}/USDT*\n` +
    `━━━━━━━━━━━━━━\n` +
    `Вход:  \`${num(sig.entry, d)}\`\n` +
    `Стоп:  \`${num(sig.stop, d)}\`  (−1R)\n` +
    `Цель:  \`${num(sig.target, d)}\`  (+${Number(sig.rr).toFixed(2)}R)\n` +
    `RSI:   ${Number(sig.rsi).toFixed(1)}\n` +
    `Таймфрейм: ${sig.interval || '15m'}`
  );
}

function fmtClose(sig) {
  const ok = sig.outcome === 'target';
  const d = priceDigits(sig.symbol);
  const base = sig.symbol.replace(/USDT$/, '');
  const emoji = ok ? '✅' : sig.outcome === 'stop' ? '🛑' : '⏱';
  const title = ok ? 'Цель достигнута' : sig.outcome === 'stop' ? 'Сработал стоп' : 'Закрыто по таймауту';
  return (
    `${emoji} ${title} — *${base}/USDT* ${sig.side}\n` +
    `Выход: \`${num(sig.exit_price, d)}\`\n` +
    `Результат: *${Number(sig.r_multiple || 0).toFixed(2)}R*`
  );
}

function num(v, d) {
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function priceDigits(sym) {
  const base = sym.replace(/USDT$/, '');
  const map = { BTC: 2, ETH: 2, SOL: 3, BNB: 2, XRP: 4, DOGE: 5, ADA: 4, LTC: 2, LINK: 3, DOT: 3, AVAX: 3, ATOM: 3, SHIB: 8 };
  return map[base] ?? 2;
}

// Отправка сигнала всем подписчикам пары
async function broadcastSignal(sig) {
  if (!token || !supa) return 0;
  const { data: subs } = await supa
    .from('user_profile')
    .select('telegram_chat_id, symbols, telegram_paused')
    .not('telegram_chat_id', 'is', null)
    .contains('symbols', [sig.symbol]);
  if (!subs || !subs.length) return 0;
  const text = fmtSignal(sig);
  let sent = 0;
  for (const row of subs) {
    if (row.telegram_paused) continue;
    await sendMessage(row.telegram_chat_id, text, { parse_mode: 'Markdown' });
    sent++;
  }
  return sent;
}

async function broadcastClose(sig) {
  if (!token || !supa) return 0;
  const { data: subs } = await supa
    .from('user_profile')
    .select('telegram_chat_id, symbols, telegram_paused')
    .not('telegram_chat_id', 'is', null)
    .contains('symbols', [sig.symbol]);
  if (!subs || !subs.length) return 0;
  const text = fmtClose(sig);
  let sent = 0;
  for (const row of subs) {
    if (row.telegram_paused) continue;
    await sendMessage(row.telegram_chat_id, text, { parse_mode: 'Markdown' });
    sent++;
  }
  return sent;
}

function stop() { polling = false; }

module.exports = { init, enabled, getBotUsername, broadcastSignal, broadcastClose, sendMessage, stop };
