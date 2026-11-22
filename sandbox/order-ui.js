/* The sandbox exchanges orders as files. All interactive state is browser-local. */
(function () {
  'use strict';

  const model = window.BearOrders;
  const rubles = new Intl.NumberFormat('ru-RU', {
    style: 'currency', currency: 'RUB', maximumFractionDigits: 0
  });
  const stamp = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit'
  });
  const titles = {cart: 'Корзина', checkout: 'Оформление', production: 'Заявки', detail: 'Лист сборки'};
  let dialog, heading, back, body, footer, feedback;
  let options, state, selectedOrder, sampleOrder, deliveryId;
  let page = 'cart';
  let busy = false;
  let readError = '';

  function readStoredState() {
    try {
      const fresh = model.readState();
      readError = '';
      return fresh;
    } catch (error) {
      readError = 'Не удалось прочитать локальные заявки. ' + (error.message || '');
      return state || {version: model.version, cart: [], orders: []};
    }
  }

  function node(tag, className, content) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (Array.isArray(content)) result.append(...content);
    else if (content !== undefined) result.textContent = String(content);
    return result;
  }

  function button(label, callback, style = 'secondary') {
    const result = node('button', 'bo-btn bo-' + style, label);
    result.type = 'button';
    result.addEventListener('click', callback);
    return result;
  }

  function announce(message = '', error = false) {
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.classList.toggle('bo-error', error);
  }

  function refreshCount() {
    const count = state.cart.reduce((sum, line) => sum + line.quantity, 0);
    if (options.onCount) options.onCount(count);
  }

  function scopeOrder(id) {
    return state.orders.find(order => order.id === id) ||
      (sampleOrder && sampleOrder.id === id ? sampleOrder : null);
  }

  function init(settings = {}) {
    if (dialog) return;
    options = settings;
    state = readStoredState();
    deliveryId = model.deliveries[0].id;
    dialog = node('dialog', 'bo-dialog');
    dialog.id = 'bear-order-dialog';
    dialog.setAttribute('aria-labelledby', 'bo-title');
    heading = node('h2', 'bo-heading');
    heading.id = 'bo-title';
    heading.tabIndex = -1;
    back = button('Назад', () => go(page === 'checkout' ? 'cart' : 'production'), 'quiet');
    const close = button('×', () => dialog.close(), 'close');
    close.setAttribute('aria-label', 'Закрыть окно');
    const badge = node('span', 'bo-demo', 'Песочница');
    const header = node('header', 'bo-header', [back, heading, badge, close]);
    feedback = node('p', 'bo-feedback');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    body = node('div', 'bo-body');
    footer = node('footer', 'bo-footer');
    dialog.append(header, feedback, body, footer);
    document.body.append(dialog);
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    window.addEventListener('storage', event => {
      if (event.key !== null && event.key !== model.storageKey) return;
      state = readStoredState();
      refreshCount();
      if (dialog.open) {
        draw();
        if (readError) announce(readError, true);
      }
    });
    refreshCount();
  }

  function go(destination, message = '', error = false) {
    if (!dialog) init();
    page = destination;
    if (!dialog.open) {
      state = readStoredState();
      dialog.showModal();
    }
    announce(readError || message, Boolean(readError) || error);
    draw();
    body.scrollTop = 0;
    heading.focus({preventScroll: true});
  }

  // Serialize changes across tabs on browsers supporting Web Locks. Always re-read
  // storage immediately before applying an update to avoid overwriting recent edits.
  async function change(makeState, after) {
    if (busy) return;
    busy = true;
    try {
      const update = () => {
        const current = model.readState();
        const next = makeState(current);
        model.writeState(next);
        state = next;
      };
      if (navigator.locks) await navigator.locks.request('bearlab-order-update-v1', update);
      else update();
      refreshCount();
      after();
    } catch (error) {
      if (!dialog.open) go('cart');
      announce(error.message || 'Не удалось сохранить изменения на этом устройстве.', true);
    } finally {
      busy = false;
    }
  }

  function draw() {
    heading.textContent = titles[page];
    back.hidden = page !== 'checkout' && page !== 'detail';
    back.setAttribute('aria-label', page === 'checkout' ? 'Назад в корзину' : 'К списку заявок');
    body.replaceChildren();
    footer.replaceChildren();
    if (page === 'cart') drawCart();
    if (page === 'checkout') drawCheckout();
    if (page === 'production') drawProduction();
    if (page === 'detail') {
      const order = scopeOrder(selectedOrder);
      if (order) drawDetail(order);
      else { go('production', 'Заявка не найдена на этом устройстве.'); return; }
    }
    footer.hidden = !footer.childElementCount;
  }

  function cartTotal(lines) {
    return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  }

  function nameOf(line) { return line.cfg.name?.trim() || 'Мишка'; }

  function totalRow(value) {
    return node('div', 'bo-total', [
      node('span', 'bo-muted', 'Демо-сумма'), node('strong', '', rubles.format(value))
    ]);
  }

  function avatar(cfg) {
    const face = node('span', 'bo-avatar', [node('span', 'bo-bear-dot')]);
    face.setAttribute('aria-hidden', 'true');
    if (/^#[a-f0-9]{6}$/i.test(cfg.main)) face.style.setProperty('--bo-fur', cfg.main);
    return face;
  }

  function summary(line) {
    const cfg = line.cfg;
    return node('div', 'bo-item-summary', [
      avatar(cfg),
      node('div', 'bo-item-name', [
        node('strong', '', nameOf(line)),
        node('p', 'bo-muted', cfg.size + ' см · ' + rubles.format(line.unitPrice) + ' за шт.')
      ])
    ]);
  }

  function quantityAction(line, delta) {
    change(current => {
      const latest = current.cart.find(item => item.id === line.id);
      if (!latest) throw new Error('Эту позицию уже удалили. Откройте корзину ещё раз.');
      return model.setQuantity(current, line.id, latest.quantity + delta);
    }, () => {
      draw();
      // Keep keyboard control on the adjusted line when rerendering the stepper.
      const id = delta > 0 ? 'more' : 'less';
      const control = document.getElementById('bo-' + id + '-' + line.id);
      (control && !control.disabled ? control : heading).focus({preventScroll: true});
    });
  }

  function drawCart() {
    if (!state.cart.length) {
      body.append(node('div', 'bo-empty', [
        node('h3', '', 'Корзина пока пуста'),
        node('p', 'bo-muted', 'Соберите мишку в мастерской и добавьте его в корзину.')
      ]));
      footer.append(button('В мастерскую', () => dialog.close(), 'primary'),
        button('Посмотреть заявки', () => go('production'), 'quiet'));
      return;
    }
    const list = node('ul', 'bo-list');
    state.cart.forEach(line => {
      const minus = button('−', () => quantityAction(line, -1), 'step');
      minus.id = 'bo-less-' + line.id;
      minus.setAttribute('aria-label', 'Уменьшить количество: ' + nameOf(line));
      minus.disabled = line.quantity <= 1;
      const plus = button('+', () => quantityAction(line, 1), 'step');
      plus.id = 'bo-more-' + line.id;
      plus.setAttribute('aria-label', 'Увеличить количество: ' + nameOf(line));
      const remove = button('Удалить', () => change(current => model.setQuantity(current, line.id, 0),
        () => go('cart', 'Позиция удалена.')), 'quiet');
      remove.setAttribute('aria-label', 'Удалить из корзины: ' + nameOf(line));
      list.append(node('li', 'bo-card', [
        summary(line),
        node('div', 'bo-item-controls', [
          node('div', 'bo-stepper', [minus, node('span', '', line.quantity), plus]), remove,
          node('b', 'bo-line-price', rubles.format(line.quantity * line.unitPrice))
        ])
      ]));
    });
    body.append(list, totalRow(cartTotal(state.cart)));
    footer.append(button('Выбрать доставку', () => go('checkout'), 'primary'),
      button('В мастерскую', () => dialog.close(), 'quiet'));
  }

  function drawCheckout() {
    if (!state.cart.length) { go('cart'); return; }
    body.append(node('p', 'bo-note', 'Шаг для взрослого. Выберите учебный адрес. Данные остаются в этом браузере.'));
    const group = node('fieldset', 'bo-choices');
    group.append(node('legend', '', 'Способ получения'));
    model.deliveries.forEach(method => {
      const radio = node('input');
      radio.type = 'radio';
      radio.name = 'bo-delivery';
      radio.value = method.id;
      radio.checked = deliveryId === method.id;
      radio.addEventListener('change', () => { deliveryId = method.id; });
      group.append(node('label', 'bo-choice', [radio, node('span', '', [
        node('b', '', method.label), node('small', '', method.description)
      ])]));
    });
    body.append(group, totalRow(cartTotal(state.cart)));
    const snapshot = JSON.stringify(state.cart);
    footer.append(button('Создать демозаявку', () => change(current => {
      if (snapshot !== JSON.stringify(current.cart)) throw new Error('Корзина изменилась. Вернитесь в корзину и проверьте состав.');
      return model.checkout(current, deliveryId);
    }, () => {
      selectedOrder = state.orders[0].id;
      go('detail', 'Демозаявка сохранена в этом браузере.');
    }), 'primary'));
  }

  function upload() {
    const input = node('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (file.size > 1024 * 1024) throw new Error('Выберите файл заявки размером до 1 МБ.');
        const raw = await file.text();
        await change(current => model.importOrder(current, raw), () => go('production', 'Заявка из файла доступна в списке.'));
      } catch (error) { announce(error.message || 'Не удалось прочитать файл.', true); }
    });
    input.click();
  }

  function example() {
    try {
      if (!sampleOrder) {
        const item = options.getExample();
        const empty = {version: 1, cart: [], orders: []};
        const cart = model.addItem(empty, item.config, item.price);
        sampleOrder = model.checkout(cart, model.deliveries[0].id).orders[0];
      }
      selectedOrder = sampleOrder.id;
      go('detail', 'Пример листа сборки. Он не добавлен в список заявок.');
    } catch (error) { announce(error.message || 'Не удалось собрать пример.', true); }
  }

  function drawProduction() {
    body.append(node('p', 'bo-note', 'Здесь собраны заявки этого браузера. Передайте коллеге файл JSON, чтобы открыть тот же лист сборки.'));
    if (state.orders.length) {
      const list = node('ul', 'bo-list');
      state.orders.forEach(order => {
        const open = button('', () => {
          selectedOrder = order.id;
          go('detail');
        }, 'order-link');
        const count = order.items.reduce((sum, line) => sum + line.quantity, 0);
        open.append(node('span', 'bo-order-text', [
          node('b', '', nameOf(order.items[0]) + (count > 1 ? ' · ' + count + ' шт.' : '')),
          node('small', '', order.id + ' · ' + stamp.format(new Date(order.createdAt)))
        ]), node('strong', '', rubles.format(order.total)));
        list.append(node('li', '', [open]));
      });
      body.append(list);
    } else {
      body.append(node('div', 'bo-empty', [node('h3', '', 'Заявок пока нет'),
        node('p', 'bo-muted', 'Оформите мишку в корзине или откройте готовый пример.')]));
    }
    footer.append(button('Импорт из JSON', upload, 'primary'));
    if (options.getExample) footer.append(button('Открыть пример', example));
  }

  function download(order) {
    try {
      const data = model.exportOrder(order);
      const url = URL.createObjectURL(new Blob([data], {type: 'application/json'}));
      const link = node('a');
      link.href = url;
      link.download = 'BearLab-' + order.id + '.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { announce(error.message || 'Не удалось выгрузить файл.', true); }
  }

  function physicalStatus(value) {
    const labels = {pending: 'Согласовать с производством', none: 'Физическая деталь не предусмотрена', yes: 'Подтверждено производством'};
    const mark = node('span', 'bo-part-note', labels[value] || labels.pending);
    mark.dataset.kind = value;
    return mark;
  }

  function assemblyList(line) {
    const wrap = node('details', 'bo-section');
    wrap.open = true;
    wrap.append(node('summary', '', 'Комплектация · ' + line.assembly.length + ' шагов'));
    const rows = node('ol', 'bo-assembly');
    line.assembly.forEach(part => {
      const code = node('code', '', part.step + ' · ' + part.slot);
      const note = physicalStatus(part.physical);
      rows.append(node('li', '', [
        node('div', 'bo-part-top', [node('b', '', part.label), code]),
        node('div', 'bo-variant', part.variant),
        node('div', 'bo-muted', part.description),
        node('div', 'bo-part-id', [part.joint && 'Стык ' + part.joint, part.parent && 'К ' + part.parent].filter(Boolean).join(' · ')), note
      ]));
    });
    wrap.append(node('p', 'bo-key', 'Левая и правая стороны указаны со стороны мишки.'), rows);
    if (line.accessories.length) {
      const extra = node('ul', 'bo-accessories');
      line.accessories.forEach(item => {
        extra.append(node('li', '', [
          node('b', '', item.label), physicalStatus(item.physical)
        ]));
      });
      wrap.append(node('h4', '', 'Аксессуары'), extra);
    }
    return wrap;
  }

  function drawDetail(order) {
    const method = model.deliveries.find(item => item.id === order.deliveryId);
    body.append(node('div', 'bo-meta', [
      node('b', '', order.id), node('span', '', stamp.format(new Date(order.createdAt))),
      node('span', '', 'Каталог ' + order.catalogVersion)
    ]), node('div', 'bo-card', [
      node('strong', '', method.label), node('p', 'bo-muted', method.description)
    ]));
    order.items.forEach(line => {
      const item = node('section', 'bo-detail-item', [
        node('div', 'bo-detail-title', [summary(line), node('b', '', line.quantity + ' шт.')]),
        assemblyList(line)
      ]);
      body.append(item);
    });
    const questions = node('details', 'bo-section', [
      node('summary', '', 'Вопросы к фабрике'),
      node('ul', 'bo-factory-questions', [
        node('li', '', 'Можно ли сшить одну основу мишки, на которую одинаково хорошо сядут худи и сарафан?'),
        node('li', '', 'Можно ли собирать разные заказы из общего запаса деталей и одежды?'),
        node('li', '', 'Какой минимальный тираж нужен для основы и для каждого комплекта одежды?'),
        node('li', '', 'Сколько времени займёт изготовление первого образца с примеркой обоих нарядов?')
      ])
    ]);
    body.append(totalRow(order.total), questions);
    footer.append(button('Скачать JSON', () => download(order), 'primary'),
      button('К заявкам', () => go('production'), 'quiet'));
  }

  window.BearOrderUI = Object.freeze({
    init,
    openCart: () => go('cart'),
    openProduction: () => go('production'),
    add: (config, price) => {
      if (!dialog) init();
      return change(current => model.addItem(current, config, price), () => go('cart', 'Мишка добавлен в корзину.'));
    }
  });
})();
