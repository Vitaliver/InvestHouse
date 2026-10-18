'use strict';

// Журнал сигналов. Пишет и читает из Supabase, если SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY заданы.
// Иначе — in-memory fallback (данные теряются при рестарте).

let supa = null;
let memStore = [];
let memSeq = 1;

function init({ supabaseUrl, serviceKey }) {
  if (supabaseUrl && serviceKey) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      supa = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
      // eslint-disable-next-line no-console
      console.log('[journal] Supabase backend active');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[journal] Supabase init failed, using in-memory fallback:', e.message);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('[journal] in-memory fallback (SUPABASE_SERVICE_ROLE_KEY not set)');
  }
}

async function insertSignal(sig) {
  if (supa) {
    const { data, error } = await supa.from('signals').insert({
      symbol: sig.symbol, side: sig.side,
      entry: sig.entry, stop: sig.stop, target: sig.target,
      rsi: sig.rsi, atr: sig.atr, rr: sig.rr,
      interval: sig.interval, outcome: 'open',
      entered_at: new Date(sig.time).toISOString(),
    }).select().single();
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[journal] insert error:', error.message);
      return null;
    }
    return data;
  }
  const row = {
    id: memSeq++,
    symbol: sig.symbol, side: sig.side,
    entry: sig.entry, stop: sig.stop, target: sig.target,
    rsi: sig.rsi, atr: sig.atr, rr: sig.rr,
    interval: sig.interval, outcome: 'open',
    entered_at: new Date(sig.time).toISOString(),
    exited_at: null, exit_price: null, r_multiple: null,
  };
  memStore.unshift(row);
  if (memStore.length > 500) memStore.length = 500;
  return row;
}

async function closeSignal(id, { outcome, exit_price, r_multiple, exited_at }) {
  const payload = {
    outcome, exit_price, r_multiple,
    exited_at: new Date(exited_at || Date.now()).toISOString(),
  };
  if (supa) {
    const { data, error } = await supa.from('signals').update(payload).eq('id', id).select().single();
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[journal] close error:', error.message);
      return null;
    }
    return data;
  }
  const row = memStore.find((r) => r.id === id);
  if (row) Object.assign(row, payload);
  return row;
}

async function listOpen() {
  if (supa) {
    const { data } = await supa.from('signals').select('*').eq('outcome', 'open').order('entered_at', { ascending: false });
    return data || [];
  }
  return memStore.filter((r) => r.outcome === 'open');
}

async function listRecent({ limit = 100, symbol, outcome } = {}) {
  if (supa) {
    let q = supa.from('signals').select('*').order('entered_at', { ascending: false }).limit(limit);
    if (symbol) q = q.eq('symbol', symbol);
    if (outcome) q = q.eq('outcome', outcome);
    const { data } = await q;
    return data || [];
  }
  let rows = memStore.slice();
  if (symbol) rows = rows.filter((r) => r.symbol === symbol);
  if (outcome) rows = rows.filter((r) => r.outcome === outcome);
  return rows.slice(0, limit);
}

async function stats({ sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  let rows;
  if (supa) {
    const { data } = await supa.from('signals')
      .select('outcome, r_multiple')
      .gte('entered_at', since)
      .not('outcome', 'eq', 'open');
    rows = data || [];
  } else {
    rows = memStore.filter((r) => r.outcome !== 'open' && r.entered_at >= since);
  }
  const count = rows.length;
  const wins  = rows.filter((r) => r.outcome === 'target').length;
  const losses = rows.filter((r) => r.outcome === 'stop').length;
  const totalR = rows.reduce((s, r) => s + (Number(r.r_multiple) || 0), 0);
  const winRate = count ? wins / count : 0;
  const avgR = count ? totalR / count : 0;
  return { sinceDays, count, wins, losses, winRate, totalR, avgR };
}

module.exports = { init, insertSignal, closeSignal, listOpen, listRecent, stats };
