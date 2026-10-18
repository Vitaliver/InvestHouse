# InvestHouse

Платформа крипто-сигналов. Движок на базе EMA + RSI + ATR анализирует Binance в реальном времени, выпускает сигналы с жёстким `R:R ≥ 1.5` и доставляет их в веб-ленту и в Telegram.

**Что получает пользователь:** регистрация через Supabase, выбор пар, живая лента сигналов (вход/стоп/цель/R:R), подключение Telegram в один клик с деталями каждого сетапа в лс, статистика (винрейт, средний R, сумма R) по 7 / 30 / 90 дням.

**Математика +EV:** при `R:R = 1.5` и винрейте 55% ожидание `0.55·1.5 − 0.45·1 = +0.375R` за сделку. Это инвариант кода: сигналы с меньшим R:R движок просто не выпускает (`src/signals/engine.js`). Реальный винрейт показан в `/signals` — честные цифры, без приукрашиваний.

**Стек:** Node.js 20+ · Express · `@supabase/supabase-js` (auth + журнал + realtime) · `technicalindicators` (EMA/RSI/ATR) · `ws` (Binance WebSocket) · чистый HTML/CSS/JS (без сборки).

## Запуск

```bash
npm install
cp .env.example .env    # заполнить Supabase + Telegram
npm run dev             # dev (node --watch, читает .env)
npm start               # продакшен
npm test                # 5 тестов
```

- http://localhost:3000 — лендинг.
- http://localhost:3000/auth — вход / регистрация.
- http://localhost:3000/signals — дашборд сигналов (гейт по сессии Supabase).

## Переменные окружения

| Имя | Описание | Обязательно |
|---|---|---|
| `SUPABASE_URL` | URL проекта из Settings → API | да |
| `SUPABASE_ANON_KEY` | публичный `anon` ключ | да |
| `SUPABASE_SERVICE_ROLE_KEY` | приватный `service_role` ключ — нужен серверу для записи сигналов и привязки Telegram | да, иначе журнал in-memory |
| `TG_BOT_TOKEN` | токен бота из `@BotFather` — для доставки в лс | нет (без него работает только веб) |
| `SIGNAL_INTERVAL` | таймфрейм стратегии (1m/5m/15m/1h/4h/1d) | нет, по умолчанию `15m` |
| `SIGNAL_PAIRS` | список пар через запятую | нет, по умолчанию 12 пар |
| `PORT` | порт сервера | нет, по умолчанию 3000 |
| `TICK_MS` | интервал обновления движка на лендинге | нет, по умолчанию 1000 |

## Настройка Supabase

1. Создайте проект на [supabase.com](https://supabase.com/).
2. **Settings → API** скопируйте `URL`, `anon public` и `service_role` в `.env`.
3. **SQL Editor → New query** вставьте и выполните содержимое `src/signals/schema.sql` — это создаст таблицы `signals` и `user_profile` с RLS и включит Realtime.
4. **Authentication → URL Configuration** добавьте разрешённые redirect-URL: `http://localhost:3000/auth` и `https://ваш-домен/auth`.
5. **Authentication → Providers → Email** оставьте включённым.

## Настройка Telegram

1. Напишите `@BotFather` → `/newbot` → задайте имя и username → скопируйте токен в `TG_BOT_TOKEN`.
2. Запустите сервер — в логах появится `[telegram] connected as @ВашБот`.
3. Пользователи подключают доставку сами: на странице `/signals` жмут «Подключить Telegram», получают 6-значный код, пишут боту `/start КОД`.
4. Поддерживаемые команды бота: `/start <code>` (привязка), `/pause` (приостановить), `/resume` (возобновить).

## Как работает движок

```
Binance WS ──▶ Scheduler ──▶ Engine (EMA+RSI+ATR) ──▶ Journal (Supabase)
                   │                                      │
                   ▼                                      ▼
             Tracker (closes on                     Realtime push ──▶ web UI
             stop/target/timeout)                   Broadcast     ──▶ Telegram DM
```

- `src/signals/stream.js` — один shared WS к Binance со списком подписанных пар.
- `src/signals/engine.js` — стратегия: EMA(fast)×EMA(slow) crossover + RSI-фильтр + ATR-стопы. Профили параметров per-symbol (BTC/ETH/SOL/… — свои). Инвариант `R:R ≥ 1.5` и антидребезг `COOLDOWN_BARS = 4`.
- `src/signals/scheduler.js` — оркестратор: буферы свечей, вызов `evaluate` на закрытии, запись в журнал, трекер закрытий.
- `src/signals/journal.js` — Supabase (с service-key) или in-memory fallback.
- `src/signals/telegram.js` — long-polling бот `getUpdates`, обработка `/start <code>`, рассылка сигналов и закрытий.
- `src/signals/api.js` — HTTP: `/api/signals/*` публично-читаемый, `/api/me/*` под JWT юзера.

## Эндпоинты

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/signals/symbols` | список отслеживаемых пар |
| GET | `/api/signals/open` | текущие открытые сигналы |
| GET | `/api/signals/recent?limit=50` | последние N сигналов |
| GET | `/api/signals/stats?days=30` | винрейт/avgR/totalR за N дней |
| GET | `/api/me/profile` | профиль юзера (пары, статус TG) — Bearer JWT |
| POST | `/api/me/profile/symbols` | обновить список пар |
| POST | `/api/me/telegram/link` | получить 6-значный код для привязки |
| POST | `/api/me/telegram/unlink` | отвязать Telegram |
| GET | `/api/config` | `{ supabase: {url, anonKey} \| null }` для клиента |
| GET | `/api/health` | uptime |
| GET | `/api/markets`, `/api/candles/:symbol`, `/api/stream` | движок лендинга (бегущая строка + hero chart) |

## Структура

```
server.js                      Express: статика + API + boot сигнального движка
src/market.js                  Внутренний котировочный движок для лендинга
src/signals/
  engine.js                    Стратегия (EMA+RSI+ATR), backtest, профили per-symbol
  stream.js                    Shared WS к Binance с reconnect
  scheduler.js                 Оркестратор: буферы, вызов engine на закрытии, tracker
  tracker                      ← внутри scheduler: closes signals on stop/target/timeout
  journal.js                   Supabase (service-key) или in-memory
  telegram.js                  Long-polling бот, /start-линк, рассылки
  api.js                       HTTP API: /api/signals/*, /api/me/*
  schema.sql                   Supabase миграция (signals, user_profile, RLS, realtime)
public/
  index.html                   Лендинг
  auth.html                    Вход и регистрация
  signals.html                 Дашборд сигналов
  security.html                О данных и безопасности
  vendor/supabase.js           @supabase/supabase-js UMD
  js, css                      Клиент
test/api.test.js               Серверные тесты + тесты движка
```

## Деплой

Workflow `.github/workflows/deploy.yml`: пуш в `main` → тесты → SSH-деплой → PM2 restart. Переменные окружения кладутся в `.env` в `APP_DIR` на сервере, PM2 перечитывает при `pm2 reload`.

Альтернатива: `Dockerfile` — Render, Railway, Fly.io подхватывают.

## Про гарантии

Сигналы — рекомендации, а не гарантия прибыли. Движок **спроектирован** так, чтобы быть в плюсе по мат. ожиданию при винрейте ≥ 55% — это чистая математика рисков (R:R ≥ 1.5). Реальный винрейт показан в разделе «Статистика» на `/signals`. Если на дистанции 100+ сделок он ниже 55%, параметры стратегии надо калибровать (`backtest()` в `engine.js` + редактирование `PROFILES`).

Торговля криптовалютами связана с высоким риском. Прошлые результаты не гарантируют будущих. Решение о входе принимает пользователь.
