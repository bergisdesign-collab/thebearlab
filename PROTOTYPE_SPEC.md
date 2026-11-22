# BearLab flat prototype — flow spec (mini)

Not a GDD. Frontend-level flow logic for the prototype: screen map, navigation, transitions, rationale, states. Layout/components live in PROTOTYPE_BLUEPRINT.md.

## Two kinds of screens (this is the core rule)
- **HUB** = a place you live in. Persistent bottom nav. Tapping a nav item switches hub and CLEARS the flow stack. Hubs: `Дом`, `Гардероб`, `Мир`, `Игры(Три в ряд)`.
- **FLOW** = a step in a task. Pushed on a back-stack, NO bottom nav (focus the task, like a checkout funnel). Back returns to the previous step keeping choices. Flow: `Мастерская`, `Мой мишка`, `Корзина`, `Доставка`, `Заявка собрана`, `Заявки`, `Лист сборки`, `Поделиться`, `Результат`.

Why: a child in a task should not be pulled away by navigation; a child "at home" should roam freely. Hubs = roam, Flow = one task, one main button.

## Transitions (who slides where)
- HUB → HUB (bottom nav): instant cross-fade. Peers, no direction.
- FLOW push (go deeper): new screen slides IN from the RIGHT; current slides OUT to the left.
- Back (pop): reverse — slides in from the LEFT.
- Modal (enter-code, import-JSON, 13-steps expand, ADMIN): slides UP from bottom over a dim; down to dismiss.
- `Заявка собрана`: enters with a celebratory scale/fade (success beat).
Reduced-motion: cross-fade everything.

## Placement rationale (why there)
- Primary action: yellow pill, bottom-center, ≥72px — one thumb, same spot every screen (child predictability).
- Back: top-left pill — standard reach, never where the thumb rests on the primary.
- Bottom nav: only on hubs — presence signals "you can roam here".
- Bear: centered above the middle — emotional focus, the subject.
- Coins/level HUD: top corners — status, never tappable into the task.
- One main action per screen (GDD: одно действие на экран).

## Screen map — who opens what, what each does
- **Дом** (hub, start): `Угостить`→bear reacts in place (no nav). `Изменить мишку`→push `Мастерская`. nav→Гардероб/Мир/Игры. cart icon→push `Корзина`.
- **Мастерская** (flow): edit bear via part tabs + tiles. `В гардероб`→replace with hub `Гардероб`.
- **Гардероб** (hub): pick outfit card (База/Худи/Сарафан) → bear + price update, persists. `Посмотреть образ`→push `Мой мишка`.
- **Мой мишка** (flow): shows look + chips. `Поделиться`→push `Поделиться`. `В корзину`→add line to order, push `Корзина`.
- **Корзина** (flow): stepper qty, remove line, total. empty→gentle prompt. `К доставке`→push `Доставка` (blocked if empty).
- **Доставка** (flow): pick Самовывоз/Курьер (radio). `Создать заявку`→checkout, push `Заявка собрана`.
- **Заявка собрана** (flow, success): order #, summary. `Открыть заявку`→push `Лист сборки`. back/home→`Дом`.
- **Заявки** (flow, via cart/list icon): list orders (diff bear per order). tap order→push `Лист сборки`. `Импорт JSON`→modal.
- **Лист сборки** (flow): components (Основа/одежда/обувь: SKU + шт/пара). `13 шагов сборки`→expand. `Скачать JSON`→copy.
- **Поделиться** (flow): bear code BEAR-…. `Скопировать ссылку`→copy. `Ввести код`→modal→load bear.
- **Мир** (hub): plaza; building `Мастерская`→push Мастерская; building `Игры`→switch hub Игры.
- **Три в ряд** (hub = Игры): swap tiles, combos, score, moves. `Подсказка`. moves=0→replace `Результат`.
- **Результат** (flow): score + device leaderboard. `Ещё раз`→Три в ряд. `Домой`→`Дом`.

## States to keep
- bear {outfit, clothes} persists (localStorage); shown on Дом/Гардероб/Мой мишка and as per-order thumbnails.
- order state via order-model.js persists (cart + orders) across reload.
- selected outfit/delivery highlighted (cyan); cart empty state; order number real.

## Admin (floating button, prototype-only)
Opens a modal:
- `Красота: вкл/выкл` — swap flat skin ↔ FLORA skin layer (bg, bear image, icons). Default flat.
- `Мишка: плоский / 2D-картинка / 3D` — bear render mode. Default flat.
- `Карта экранов` — jump to any of the 13 (for demo/review).
Why: owner evaluates pure flow on flat, then commands beauty; one place to toggle, nothing hardcoded.

## Full interaction contract (bug-free guard)
Every visible control, its effect, and back/persist. Tap on empty = nothing. This is the source of truth; `flat/flow-test.mjs` walks it on every change.

| Screen | Control | Effect |
|---|---|---|
| Дом | Угостить | bear animates + toast, NO navigation |
| Дом | Изменить мишку | push Мастерская |
| Дом/все хабы | нижнее меню | switchHub (очищает стек) |
| Мастерская | ‹ | pop |
| Мастерская | плитки плюша | меняют цвет мишки, сохраняется (голубой выбор) |
| Мастерская | В гардероб | switchHub Гардероб |
| Гардероб | карточка образа ×3 | set clothes → мишка+цена, persist, голубая рамка |
| Гардероб | Посмотреть образ | push Мой мишка |
| Мой мишка | В корзину | addItem + toast + push Корзина |
| Мой мишка | Поделиться | push Поделиться |
| Корзина | − / + | setQuantity (0 удаляет), пересчёт итога |
| Корзина | Удалить | setQuantity 0 |
| Корзина | Заявки (↗) | push Заявки |
| Корзина | К доставке | push Доставка (disabled если пусто) |
| Доставка | Самовывоз/Курьер | set pick (голубой) |
| Доставка | Создать заявку | checkout → push Заявка собрана |
| Заявка собрана | Открыть заявку | push Лист сборки |
| Заявка собрана | Домой | switchHub Дом |
| Заявки | строка заявки | push Лист сборки |
| Заявки | Импорт JSON | importOrder из textarea |
| Лист сборки | N шагов сборки | раскрыть/свернуть 13 шагов |
| Лист сборки | Скачать JSON | copy exportOrder |
| Поделиться | Скопировать ссылку | copy кода BEAR- |
| Поделиться | Ввести код | dec → bear, persist |
| Мир | здания | Мастерская→push, Игры/Гардероб→switchHub |
| Три в ряд | фишка | выбор/свап; матч → +очки, −ход; ходы=0 → Результат |
| Три в ряд | Заново | новое поле |
| Результат | Ещё раз / Домой | новая игра / switchHub Дом |
| Админка (⚙) | Красота вкл/выкл | body.beauty (место под FLORA-скин) |
| Админка | Мишка плоский/2D/3D | режим мишки (заглушка под FLORA/3D) |
| Админка | Карта экранов | прыжок на любой из 13 |

Persist: bear, корзина, заявки, рекорды — переживают перезагрузку. Back всегда сохраняет выбор (состояние глобальное).
