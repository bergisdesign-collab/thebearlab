# Запуск в Google Cloud Run — пошагово

Токены и ключи вводятся только в BotFather, Notion, Google Cloud и в секреты GitHub — никогда в чат и не в код.

Что получится: бот работает в Cloud Run (регион Бельгия, europe-west1), данные — в Firestore,
раз в 10 минут Cloud Scheduler будит бота: синхронизация с Notion + сводки в 09:00, 18:00 и в пятницу.
Каждый `git push` в `main` прогоняет тесты и сам выкладывает новую версию.

## 1. Telegram-бот

1. [@BotFather](https://t.me/BotFather) → `/newbot` → имя **the Bear Lab Bot**, username **TheBearLabBot** (если занят — любой свободный). Токен → секрет `BOT_TOKEN`.
2. Свой Telegram id (например, у @userinfobot) → секрет `ADMIN_IDS`. Несколько — через `;`.

## 2. Notion

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration (Internal).
   Capabilities: Read content, Update content, Insert content, **Read user information without email**.
2. Internal Integration Secret → секрет `NOTION_TOKEN`.
3. Страница проекта TheBearLab → `•••` → Connections → добавь интеграцию (доступ получат все три базы).

## 3. Google Cloud

1. [console.cloud.google.com](https://console.cloud.google.com) → создай проект (например, `thebearlab`). Запомни его **ID**.
2. Привяжи платёжный аккаунт (Billing). Без карты Cloud Run не включается, но наша нагрузка укладывается
   в бесплатный уровень. Для спокойствия: Billing → Budgets → бюджет $1 с уведомлением на почту.
3. Открой Cloud Shell (значок `>_` вверху справа) и выполни:
   ```bash
   git clone https://github.com/bergisdesign-collab/thebearlab.git
   bash thebearlab/bot/deploy/gcp_setup.sh <ID_ПРОЕКТА>
   ```
   Скрипт включит нужные сервисы, создаст базу Firestore, выдаст права и создаст ключ для GitHub.
   В конце покажет, что скопировать. После копирования ключа удали файл (команда будет в выводе).

## 4. Секреты GitHub

Репозиторий → Settings → Secrets and variables → Actions → New repository secret:

| Секрет | Значение |
|---|---|
| `GCP_PROJECT` | ID проекта |
| `GCP_SA_KEY` | ключ из Cloud Shell целиком |
| `BOT_TOKEN` | токен от BotFather |
| `NOTION_TOKEN` | секрет интеграции Notion |
| `ADMIN_IDS` | твой Telegram id |
| `WEBHOOK_SECRET` | любая строка из латиницы/цифр, 30+ символов |
| `CRON_SECRET` | ещё одна такая строка (другая) |

Случайную строку можно получить в Cloud Shell: `openssl rand -hex 24`.

## 5. Выкладка

GitHub → Actions → **Bot tests & deploy** → Run workflow. Сценарий:
тесты → сборка и выкладка в Cloud Run → регистрация webhook в Telegram и меню команд →
создание задания Cloud Scheduler `tbl-tick` (каждые 10 минут). Первая синхронизация с Notion пройдёт
в течение 10 минут; можно не ждать и отправить боту `/sync`.

## 6. В Telegram

1. Напиши боту `/start` — ты администратор (если твой id в `ADMIN_IDS`).
2. Добавь бота в общий чат команды и отправь там `/bindchat`.
3. Партнёры пишут боту `/start` → тебе приходит заявка → «Принять».
4. Каждый в `/team` привязывает себя к своему пользователю Notion.

## Как это работает

- **Синхронизация.** Изменение в боте уходит в Notion сразу после нажатия кнопки. Изменения из Notion
  приходят в бота каждые 10 минут или по `/sync`. Если одно поле поменяли в обоих местах между
  синхронизациями — побеждает бот.
- **Расписание.** Задание будит бота каждые 10 минут; сводки уходят на первом «пробуждении» после
  09:00 / 18:00 (то есть до 09:10), один раз в день.
- **Холодный старт.** Без сообщений сервер засыпает; первый ответ после паузы приходит через 2–5 секунд,
  дальше — мгновенно.
- **Логи.** Cloud Console → Cloud Run → thebearlab-bot → Logs.

## Стоимость

При нашей нагрузке всё в пределах бесплатного уровня: Cloud Run (2 млн запросов/мес), Firestore
(50 тыс. чтений и 20 тыс. записей в день — бот хранит каждый тип данных одним документом,
поэтому тратит сотни операций в день), Cloud Scheduler (3 задания бесплатно, у нас одно).
Единственное, что может стоить центы — хранение собранных образов в Artifact Registry сверх 0,5 ГБ;
старые версии можно удалять в Artifact Registry → cloud-run-source-deploy.
