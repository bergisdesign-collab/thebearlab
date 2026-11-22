# BearLab prototype — blueprint from the 13 references

Source of truth = the 13 screen references. Layout/placement derive from them. Prototype is 2D, component-based, FLAT first; beauty (FLORA bg + cute 2D bear + icons) is a toggleable skin layer added on command. Real 3D bear (three.js) is a later game track, available behind an admin toggle.

## Build order
1. FLAT prototype: all 13 screens, exact layout per references, fully functional, flow-to-purchase + mini-game, desktop + mobile.
2. Admin button → toggles: `beauty on/off` (flat↔skin) and `bear mode` (flat / 2D-FLORA image / 3D three.js).
3. On command: FLORA generates bg + per-outfit bear + icons; drop into the skin layer. Structure unchanged.

## Design tokens
- bg room: warm lavender/purple illustration (flat = solid #5b3fa6 gradient)
- content cards: cream #f5efe6 (order/cart/sheet)
- primary button: YELLOW pill #ffce3a, dark text #3a2270, bottom-shadow, full-width, ≥72px, bottom
- accent / controls / selected: CYAN #43d6e0 (steppers, radios, selected outline, secondary buttons, "Домой")
- panels: purple #4a3178
- HUD: level avatar+bar left, coins yellow right

## Components (reusable, change in one place)
appbar(back pill + centered title [+ coins]) · hud(level+coins) · bottomnav(Дом/Гардероб/Мир/Игры, active=lavender pill) · hero(bear big center) · btnPrimary(yellow) · btnSecondary(cyan) · cardCream · outfitCard(thumb+name+price, selected=cyan outline) · tile(swatch, selected=cyan outline) · optionRow(icon+label+radio, cyan check) · stepper(cyan −/qty/+) · badge(cyan pill: delivery, "1 шт"/"1 пара") · listRow(thumb+BL#+badge+chevron) · tabs(cyan active) · gameGrid(themed pieces)

## Per-screen layout (where everything sits)
1. Дом: HUD; bear hero center; «Угостить»(yellow); bottomnav. Entry to Мастерская.
2. Мастерская: appbar(back)+title; bear hero in craft room; bottom panel = part tabs (Плюш/Мордочка/Лапы, cyan active) + swatch tiles (selected cyan) + undo + «В гардероб»(yellow).
3. Гардероб: appbar; bear hero; chosen chips; 3 outfit cards (База / Худи / Сарафан, selected outline); «Посмотреть образ»(yellow).
4. Мой мишка: appbar; bear hero; item chips (Худи/Кеды); rotate btn; «Поделиться»(cyan); «В корзину»(yellow).
5. Корзина: appbar; cream card(thumb + «Мой мишка» + «Худи·Кеды» + stepper cyan); «Итого» row; «К доставке»(yellow). Empty state.
6. Доставка: appbar; parcel hero; cream card: Самовывоз / Курьер rows(icon+radio, cyan check) + демозаказ thumb; «Создать заявку»(yellow).
7. Заявка собрана: title + BL#; open-box hero(stars); cream card(thumb + Самовывоз + «N мишка»); «Сохранено на устройстве»; «Открыть заявку»(yellow).
8. Заявки: appbar+coins; list order cards(thumb + BL# + delivery badge cyan + chevron, different bear per order); «Импорт JSON»(yellow).
9. Лист сборки: appbar(BL#)+coins; big card: bear + component cards (Основа/Худи/Кеды: thumb + SKU + «1 шт»/«1 пара»); «13 шагов сборки» collapsible; worksheet ticket (decor); «Скачать JSON»(yellow).
10. Поделиться: appbar+coins; polaroid bear card «Образ мишки»; «Скопировать ссылку»(yellow); «Ввести код»(cyan).
11. Мир: HUD; illustrated plaza; buildings Мастерская / Игры = hotspots; bottomnav(Мир active).
12. Три в ряд: appbar + bear peek; Очки / Ходы panels; 7×8 themed grid (stars/spools/buttons/paws/strawberries, swap + arrow); «Подсказка»(yellow).
13. Результат: stars + «Результат» banner; bear celebrating + confetti; score pill; «Рекорды устройства» leaderboard; «Ещё раз»(yellow) + «Домой»(cyan).

## Data / engine
Reuse Dima's `order-model.js` (BearOrders): cart, quantity, delivery, checkout→orders, build sheet (13 ASM + clothing SKUs, шт/пара), export/import JSON, persistence. Bear look = {outfit, clothes} → thumbnails per order. Share code BEAR-… via enc/dec.

## Acceptance (per references)
Each screen: every visible control acts; tap on empty does nothing; placement matches the reference on mobile (390px) and desktop; back keeps choice; reload keeps cart/orders. Factory test: pick sundress → bear shows sundress → order sheet lists Сарафан+Ботинки; remove boots → gone from bear and sheet.
