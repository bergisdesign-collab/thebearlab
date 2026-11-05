# Запуск в Yandex Cloud — пошагово

Токены и ключи вводятся только в BotFather, Notion, Yandex Cloud и в секреты GitHub — никогда в чат и не в код.
Команды `yc` выполняются в [Cloud Shell](https://console.yandex.cloud) или локально после `yc init`.

## 1. Telegram-бот

1. [@BotFather](https://t.me/BotFather) → `/newbot` → имя **the Bear Lab Bot**, username **TheBearLabBot** (если занят — любой свободный).
2. Сохрани токен — это секрет `BOT_TOKEN`.
3. Узнай свой Telegram id (например, у @userinfobot) — это `ADMIN_IDS`. Партнёров можно добавить через `;`: `111;222`.
   Без `ADMIN_IDS` администратором станет первый, кто напишет боту `/start`.

## 2. Notion

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration (Internal), рабочее пространство TheBearLab.
   Capabilities: Read content, Update content, Insert content, **Read user information without email**.
2. Скопируй Internal Integration Secret — это `NOTION_TOKEN`.
3. Открой страницу проекта TheBearLab → `•••` → Connections → добавь интеграцию. Доступ получат все три базы (Задачи, Вехи, Идеи).

## 3. Yandex Cloud

```bash
FOLDER_ID=$(yc config get folder-id)

# сервисный аккаунт для функции и для GitHub Actions
yc iam service-account create --name tbl-bot
SA_ID=$(yc iam service-account get tbl-bot --format json | jq -r .id)
for role in ydb.editor functions.editor iam.serviceAccounts.user serverless.functions.invoker; do
  yc resource-manager folder add-access-binding "$FOLDER_ID" --role $role --subject serviceAccount:$SA_ID
done
yc iam key create --service-account-name tbl-bot -o tbl-bot-key.json   # содержимое → секрет YC_SA_KEY_JSON

# база
yc ydb database create tbl --serverless
yc ydb database get tbl            # endpoint: grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/...
#   YDB_ENDPOINT = grpcs://ydb.serverless.yandexcloud.net:2135
#   YDB_DATABASE = /ru-central1/...   (часть после database=)

# функция (код зальёт GitHub Actions)
yc serverless function create --name thebearlab-bot
yc serverless function allow-unauthenticated-invoke thebearlab-bot
yc serverless function get thebearlab-bot     # запомни id функции
```

После загрузки ключа удали файл `tbl-bot-key.json` с диска.

## 4. Секреты GitHub

Репозиторий → Settings → Secrets and variables → Actions → New repository secret:

| Секрет | Значение |
|---|---|
| `BOT_TOKEN` | токен от BotFather |
| `WEBHOOK_SECRET` | любая строка из латиницы/цифр/`_-`, 20+ символов |
| `ADMIN_IDS` | твой Telegram id (через `;` для нескольких) |
| `NOTION_TOKEN` | секрет интеграции Notion |
| `YDB_ENDPOINT`, `YDB_DATABASE` | из шага 3 |
| `YC_SA_KEY_JSON` | всё содержимое `tbl-bot-key.json` |
| `YC_FOLDER_ID` | id каталога |
| `YC_SERVICE_ACCOUNT_ID` | `$SA_ID` |
| `GH_DISPATCH_TOKEN` | необязательно: fine-grained token с правом *Actions: Read and write* на этот репозиторий — для мгновенного `/sync` |

## 5. Первый запуск

1. GitHub → Actions → **Bot tests & deploy** → Run workflow. Тесты + выкладка новой версии функции.
2. Actions → **Notion sync** → Run workflow. Создаст таблицы в YDB и загрузит все задачи, вехи, идеи и пользователей Notion.
   Дальше синхронизация идёт сама каждые 15 минут.
3. Подготовка бота (меню команд):
   ```bash
   yc serverless function invoke thebearlab-bot -d '{"messages":[{"details":{"payload":"setup"}}]}'
   ```
4. Webhook — открой в браузере (подставь свои значения):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://functions.yandexcloud.net/<ID_ФУНКЦИИ>&secret_token=<WEBHOOK_SECRET>
   ```
   Ответ `"ok":true` — бот на связи.
5. Таймеры (время в UTC, МСК = UTC+3):
   ```bash
   for t in "morning|0 6 ? * * *" "evening|0 15 ? * * *" "weekly|0 15 ? * FRI *"; do
     name=${t%%|*}; cron=${t#*|}
     yc serverless trigger create timer --name tbl-$name --cron-expression "$cron" \
       --invoke-function-name thebearlab-bot --invoke-function-service-account-id $SA_ID --payload $name
   done
   ```

## 6. В Telegram

1. Напиши боту `/start` — ты администратор.
2. Добавь бота в общий чат команды и отправь там `/bindchat`.
3. Партнёры пишут боту `/start` → тебе приходит заявка → «Принять».
4. Каждый в `/team` привязывает себя к своему пользователю Notion — тогда назначения из бота видны в Notion и наоборот.

## Как устроена синхронизация

- Всё, что изменили в Notion, приходит в бота за ≤15 минут.
- Изменения из бота уходят в Notion в ту же синхронизацию. Если одно и то же поле поменяли и там, и там
  в одном 15-минутном окне — побеждает бот (его правка новее по смыслу и уже разослана команде).
- Задачи, созданные в боте, появляются в Notion; удалённые в Notion — скрываются в боте.
- Ход каждого запуска виден в GitHub → Actions → Notion sync.

## Стоимость

Нагрузка — сотни вызовов функции и запросов к YDB в день; обычно это укладывается в бесплатный
уровень Yandex Cloud, но актуальные лимиты стоит проверить в тарифах Cloud Functions и YDB Serverless.
GitHub Actions для публичного репозитория бесплатен. Если репозиторий станет приватным, синхронизация
каждые 15 минут займёт ≈2900 минут в месяц — больше бесплатных 2000; тогда поставь cron `*/30` в
`.github/workflows/notion-sync.yml`.
