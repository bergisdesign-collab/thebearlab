# BOLVANKA — shared plan for Claude, Codex, Cursor

Goal: a phone-first clickable BearLab болванка that Ilia & Dima open on a phone, walk any of 13 screens, show the factory, and change ideas cheaply. One repo, shared art, every screen does one meaningful action.

Live after merge:
- `/` болванка (this prototype)
- `/studio/` existing 3D app (конструктор, корзина, одежда, заявка, лист сборки)

## Architecture rule (all agents)
Decompose each screen into reusable parts, NOT baked images:
- `art/` — clean backgrounds (room, world), hero bear renders per outfit, item images, icons. Shared across agents; regenerate only when adding graphics.
- `components/` — buttons, cards, nav, price, quantity, selection highlight as HTML/CSS. Edited in one place.
- `screens/*` — compose a screen from art + components + data.
- Order data (number, SKUs, qty, thumbnail) comes from the existing order model in `/studio/sandbox/order-model.js`. Never hardcode.

Control screen first: **Гардероб**. Prove on 390px: looks like concept; can pick Сарафан; can move a button with one CSS edit; chosen bear reaches cart with the same look. Then repeat for the rest.

## Screen depth (min viable per screen)
| # | Screen | Must do |
|---|---|---|
| 01 Дом | «Угостить» reaction; go to Гардероб/Мир/Игры; «Изменить мишку» → /studio |
| 02 Мастерская | opens /studio 3D; returns keeping config |
| 03 Гардероб | База / Худи+кеды / Сарафан+ботинки visibly different on tap; choice persists to cart & заявка |
| 04 Мой мишка | shows chosen look + item chips; rotate; В корзину passes snapshot |
| 05 Корзина | two different bears; qty; remove; total recompute |
| 06 Доставка | самовывоз / курьер; create local demo order |
| 07 Заявка собрана | real number + contents; no duplicate on re-tap |
| 08 Заявки (master) | list; import validated JSON shows same order |
| 09 Лист сборки | thumbnail, состав, qty, SKUs, 13 steps, export; обувь = «пара», одежда/аксессуары отдельными строками |
| 10 Поделиться | link carries образ only; enter code restores |
| 11 Мир | one static scene, 2 live zones → мастерская, игры |
| 12 Три в ряд | short round, score, replay; one daily board + share result; подпись «Рекорды устройства» |
| 13 Результат | replay / home |
| Карта | «Мастер» mode map of all screens + demo examples (empty cart, two bears, ready заявка) |

## Acceptance (factory test)
Add bear in худи+кеды, then переодень in сарафан+ботинки, add a second bear, choose самовывоз. After reload: заявка keeps two different thumbnails and two correct составы. Dima opens the same order via JSON on another phone. Works on 390px.

## Roles
- Claude: component kit, Гардероб→full order route, /studio.
- Codex: order-route correctness + acceptance test + merge approved PRs.
- Cursor+Grok: CSS tweaks, per-screen layout.
- Graphics (FLORA, owner approval): 3 hero renders (base/hoodie/sundress), clean room bg, item cutouts.

## Graphics still needed
- Hero bear renders: base plush; hoodie+sneakers; sundress+boots — same pose & camera.
- Clean room background (no bear); bear cut out; item images (hoodie, sneakers, dress, boots, cap, pants).
