# the Bear Lab Bot — Cloudflare Workers

Рабочая версия бота. Бесплатно, без карты и без сервера: Cloudflare запускает код на каждое сообщение
из Telegram и раз в 10 минут по расписанию.

```
Telegram ──webhook──► Cloudflare Worker ──► D1 (база бота)
                          │   ▲
          правки из бота ─┘   └─ cron каждые 10 мин: синхронизация + сводки 09:00 / 18:00 / пт (МСК)
                          ▼
                       Notion
```

Возможности те же, что у Python-версии в `../bot` (она остаётся запасным вариантом для своего сервера):
сводки, напоминания, задачи с историей, наставник `/next`, идеи, поиск, двусторонняя синхронизация с Notion.

## Запуск — пошагово

Токены и ключи вводятся только в BotFather, Notion, Cloudflare и в секреты GitHub — не в чат и не в код.

### 1. Cloudflare

1. Зарегистрируйся на [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) — нужна только почта, карта не нужна.
2. В меню слева открой **Workers & Pages** один раз — Cloudflare предложит адрес вида `имя.workers.dev`, подтверди.
3. **Account ID**: на той же странице справа (или в адресной строке после `dash.cloudflare.com/`). Это секрет `CLOUDFLARE_ACCOUNT_ID`.
4. **API-токен**: значок профиля → My Profile → API Tokens → Create Token → шаблон **Edit Cloudflare Workers** →
   в Permissions добавь строку **Account · D1 · Edit** → Continue → Create. Скопируй токен — это `CLOUDFLARE_API_TOKEN`.

### 2. Секреты GitHub

Репозиторий → Settings → Secrets and variables → Actions → New repository secret:

| Секрет | Значение |
|---|---|
| `CLOUDFLARE_API_TOKEN` | токен из шага 1.4 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID |
| `BOT_TOKEN` | токен от BotFather (новый, после `/revoke`) |
| `NOTION_TOKEN` | API token подключения Notion (`ntn_…`) |
| `ADMIN_IDS` | твой @username или Telegram id; несколько — через `;`, например `@me;@partner` |

### 3. Выкладка

GitHub → Actions → **Worker tests & deploy** → Run workflow. Сценарий: тесты → создание базы D1 →
выкладка → секреты (пароли для webhook генерируются сами) → регистрация webhook и меню команд в Telegram. Дальше каждый `git push` в `worker/`
выкладывает новую версию сам.

### 4. В Telegram

1. `/start` боту в личку — ты администратор.
2. Добавь бота в общий чат и отправь там `/bindchat`.
3. `/sync` — сразу подтянуть задачи из Notion (иначе в течение 10 минут).
4. Партнёры пишут `/start` → тебе приходит заявка → «Принять». Каждый в `/team` привязывает себя к Notion.

## Лимиты бесплатного плана и как бот в них укладывается

- 100 000 запросов в день — бот тратит сотни.
- 10 мс процессора на запрос — ожидание Notion/Telegram не считается, логика бота занимает единицы миллисекунд.
- 50 внешних запросов за вызов — синхронизация отправляет в Notion не больше 35 изменений за раз, остальные уходят следующим заходом.
- База D1: 100 000 записей в день — синхронизация пишет только то, что изменилось.

Если упрёмся в лимиты — переезжаем на свой сервер (Python-версия в `../bot`) или на платный план Cloudflare ($5/мес).

## Разработка

```bash
cd worker
npm test            # тесты на Node 22, без установки пакетов
npm install && npx tsc --noEmit
npx wrangler dev    # локальный запуск (нужен npm install)
```

Логи: Cloudflare → Workers & Pages → thebearlab-bot → Logs.
