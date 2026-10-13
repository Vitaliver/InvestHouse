'use strict';

const path = require('path');
const express = require('express');
const { Market } = require('./src/market');

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = Number(process.env.TICK_MS) || 1000;

function createApp(market = new Market()) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.get('/api/markets', (req, res) => {
    res.json(market.list());
  });

  app.get('/api/candles/:symbol', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 600);
    const candles = market.candles(req.params.symbol.toUpperCase(), limit);
    if (!candles) return res.status(404).json({ error: 'Unknown symbol' });
    res.json(candles);
  });

  // Поток котировок через Server-Sent Events
  app.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(market.list())}\n\n`);
    const unsubscribe = market.subscribe((updates) => {
      res.write(`data: ${JSON.stringify(updates)}\n\n`);
    });
    req.on('close', unsubscribe);
  });

  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

  app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  });

  return app;
}

if (require.main === module) {
  const market = new Market();
  setInterval(() => market.tick(), TICK_MS);
  createApp(market).listen(PORT, () => {
    console.log(`InvestHouse запущен: http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
