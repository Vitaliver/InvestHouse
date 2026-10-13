// Лёгкий свечной график на canvas без зависимостей
(function (global) {
  class CandleChart {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({
        bg: '#0d1b2a',
        grid: 'rgba(255,255,255,0.05)',
        text: '#7d8fa3',
        up: '#22c55e',
        down: '#ef4444',
        axes: true,
        crosshair: true,
        maxCandles: 120,
      }, opts);
      this.candles = [];
      this.digits = 2;
      this.mouse = null;
      this.onHover = null;

      this.resize = this.resize.bind(this);
      new ResizeObserver(this.resize).observe(canvas);
      if (this.opts.crosshair) {
        canvas.addEventListener('mousemove', (e) => {
          const r = canvas.getBoundingClientRect();
          this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
          this.draw();
        });
        canvas.addEventListener('mouseleave', () => { this.mouse = null; this.draw(); });
      }
      this.resize();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = this.canvas.getBoundingClientRect();
      this.w = width;
      this.h = height;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    setData(candles, digits) {
      this.candles = candles.slice();
      if (digits != null) this.digits = digits;
      this.draw();
    }

    // Обновление последней свечи или добавление новой
    update(candle) {
      const last = this.candles[this.candles.length - 1];
      if (last && last.time === candle.time) Object.assign(last, candle);
      else if (!last || candle.time > last.time) this.candles.push({ ...candle });
      this.draw();
    }

    draw() {
      const { ctx, w, h, opts } = this;
      if (!w || !h) return;
      ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, w, h);

      const data = this.candles.slice(-opts.maxCandles);
      if (!data.length) return;

      const padR = opts.axes ? 70 : 8;
      const padB = opts.axes ? 24 : 8;
      const padT = 12;
      const cw = w - padR;
      const ch = h - padB - padT;

      let lo = Infinity;
      let hi = -Infinity;
      for (const c of data) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
      const pad = (hi - lo) * 0.08 || hi * 0.001;
      lo -= pad; hi += pad;
      const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ch;
      const step = cw / opts.maxCandles;
      const offset = cw - data.length * step;
      const bodyW = Math.max(1, step * 0.65);

      // Сетка и ось цен
      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const rows = 6;
      for (let i = 0; i <= rows; i++) {
        const v = lo + ((hi - lo) * i) / rows;
        const yy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = opts.grid;
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(cw, yy); ctx.stroke();
        if (opts.axes) { ctx.fillStyle = opts.text; ctx.fillText(v.toFixed(this.digits), cw + 8, yy); }
      }
      if (opts.axes) {
        ctx.textAlign = 'center';
        const every = Math.ceil(data.length / 6);
        data.forEach((c, i) => {
          if (i % every) return;
          const x = offset + i * step + step / 2;
          ctx.strokeStyle = opts.grid;
          ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ch); ctx.stroke();
          const d = new Date(c.time);
          ctx.fillStyle = opts.text;
          ctx.fillText(d.toTimeString().slice(0, 5), x, h - padB / 2);
        });
        ctx.textAlign = 'left';
      }

      // Свечи
      data.forEach((c, i) => {
        const x = offset + i * step + step / 2;
        const color = c.close >= c.open ? opts.up : opts.down;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, y(c.high));
        ctx.lineTo(Math.round(x) + 0.5, y(c.low));
        ctx.stroke();
        const top = y(Math.max(c.open, c.close));
        const bh = Math.max(1, Math.abs(y(c.open) - y(c.close)));
        ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
      });

      // Линия текущей цены
      const last = data[data.length - 1];
      const ly = Math.round(y(last.close)) + 0.5;
      const lc = last.close >= last.open ? opts.up : opts.down;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = lc;
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(cw, ly); ctx.stroke();
      ctx.setLineDash([]);
      if (opts.axes) {
        ctx.fillStyle = lc;
        ctx.fillRect(cw, ly - 10, padR, 20);
        ctx.fillStyle = '#fff';
        ctx.fillText(last.close.toFixed(this.digits), cw + 8, ly);
      }

      // Перекрестие
      if (this.mouse && this.mouse.x < cw && this.mouse.y > padT && this.mouse.y < padT + ch) {
        const { x: mx, y: my } = this.mouse;
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, padT + ch); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(cw, my); ctx.stroke();
        ctx.setLineDash([]);
        if (opts.axes) {
          const v = lo + (1 - (my - padT) / ch) * (hi - lo);
          ctx.fillStyle = '#334155';
          ctx.fillRect(cw, my - 10, padR, 20);
          ctx.fillStyle = '#fff';
          ctx.fillText(v.toFixed(this.digits), cw + 8, my);
        }
        const idx = Math.floor((mx - offset) / step);
        if (this.onHover) this.onHover(data[idx] || null);
      } else if (this.onHover) {
        this.onHover(null);
      }
    }
  }

  // Агрегация минутных свечей в более крупный таймфрейм
  CandleChart.aggregate = function (candles, minutes) {
    if (minutes <= 1) return candles.map((c) => ({ ...c }));
    const ms = minutes * 60000;
    const out = [];
    for (const c of candles) {
      const t = Math.floor(c.time / ms) * ms;
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
      } else {
        out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
      }
    }
    return out;
  };

  global.CandleChart = CandleChart;
})(window);
