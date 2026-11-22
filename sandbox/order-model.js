/* Versioned, offline sandbox order model. The 13 rows follow BearLab GDD v1, ASM-01..13. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BearOrders = api;
})(typeof globalThis === 'undefined' ? window : globalThis, function () {
  'use strict';

  const version = 1;
  const catalogVersion = 'sandbox-asm-v1';
  const storageKey = 'bearlab.orders.v1';
  const maxLines = 24;
  const maxOrders = 100;
  const maxQuantity = 99;
  const maxExportLength = 400000;
  const deliveries = [
    {id: 'pickup', label: 'Пункт выдачи', description: 'Тестовый пункт в мастерской'},
    {id: 'courier', label: 'Курьер', description: 'Тестовая доставка до двери'}
  ];
  const defaults = {
    size: '30', name: '', furType: 'fluffy', furLen: .5, furDensity: .55,
    main: '#9b6a43', accent: '#e2bf98', earColor: '', limbColor: '', pads: '#e2bf98',
    nose: '#2a1d18', tip: '#d9ad7c', tipMix: .3, pattern: 'none', patternColor: '#f5efe6',
    headShape: 'round', headSize: .5, muzzleSize: .5, ears: 'round', earSize: .5, earPos: .5,
    eyes: 'button', eyeSize: .5, eyeSpacing: .5, eyeHeight: .45, iris: '#3b5bdb',
    glow: false, eyeSpots: false, mouth: 'line', emotion: .45, browTilt: 0,
    brows: false, blush: false, noseType: 'oval', body: 'normal', bodyWidth: .5,
    belly: true, tail: true, pose: 'sit', armLen: .5, armThick: .5, armPose: .35,
    claws: false, legLen: .5, legThick: .5, acc: [], glbTint: 0, model: 'teddy', outfit: 'base', clothes: []
  };
  const labels = {
    size: {'20': '20 см', '30': '30 см', '45': '45 см'},
    outfit: {base:'Без базового комплекта', hoodie:'Худи', sundress:'Сарафан'},
    furType: {smooth:'Гладкий', short:'Короткий', fluffy:'Пушистый', xfluffy:'Очень пушистый', curly:'Кудрявый'},
    pattern: {none:'Однотонный', spots:'Пятна', stripes:'Полоски', hearts:'Сердечки', stars:'Звёзды', patches:'Заплатки', gradient:'Градиент'},
    headShape: {round:'Круглая', wide:'Широкая', oval:'Вытянутая'},
    ears: {round:'круглые', pointy:'острые', floppy:'висячие', bunny:'заячьи', cyber:'кибер-уши'},
    eyes: {button:'пуговки', glossy:'блестящие', anime:'аниме', sleepy:'сонные', stitched:'вышитые крестики', star:'звёздочки'},
    mouth: {line:'классический', open:'открытый', cat:'кошачий', fangs:'с клыками'},
    noseType: {oval:'овал', heart:'сердце', big:'крупный'},
    body: {normal:'Обычный', chubby:'Округлый', slim:'Стройный', muscle:'С рельефом'},
    pose: {sit:'сидя', stand:'стоя'},
    model: {teddy:'Плюшевый', parts:'Из деталей', custom:'Свой 3D-файл'}
  };
  const accessories = {
    glasses:'Очки', patch:'Повязка пирата', crown:'Корона', pirate:'Шляпа пирата',
    cap:'Кепка', helmet:'Каска пожарного', headphones:'Наушники', chain:'Цепочка',
    bowtie:'Бабочка', scarf:'Шарф', cape:'Плащ героя', watch:'Часы',
    plaster:'Пластырь', guitar:'Гитара'
  };
  const attachmentGroup = {glasses:'eyes', patch:'eyes', crown:'head', pirate:'head', cap:'head', helmet:'head',
    headphones:'ears', chain:'neck', bowtie:'neck', scarf:'neck', cape:'back', watch:'wrist', plaster:'face', guitar:'hands'};
  const clothingSlots = ['top','bottom','feet','wrist'];
  const clothingId = id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,47}$/i.test(id);
  const colors = new Set(['main','accent','earColor','limbColor','pads','nose','tip','patternColor','iris']);
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function requireValue(value, message) { if (!value) throw new Error(message); }
  function assertKeys(object, allowed) {
    requireValue(plain(object) && Object.keys(object).every(key => allowed.includes(key)), 'Файл содержит неизвестные поля.');
  }
  function deepFreeze(value) {
    if (plain(value) || Array.isArray(value)) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }
  function normalizeConfig(source) {
    assertKeys(source, Object.keys(defaults));
    const cfg = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = has(source, key) ? source[key] : fallback;
      let ok = true;
      if (key === 'acc') {
        ok = Array.isArray(value) && value.length <= 10 && value.every(id => typeof id === 'string' && has(accessories,id));
        if (ok) ok = new Set(value.map(id => attachmentGroup[id])).size === value.length;
      } else if (key === 'clothes') {
        ok = Array.isArray(value) && value.length <= clothingSlots.length && value.every(clothingId) && new Set(value).size === value.length;
      } else if (key === 'name') {
        ok = typeof value === 'string' && [...value].length <= 10 && !/[\u0000-\u001f\u007f]/.test(value);
      } else if (has(labels,key)) {
        ok = typeof value === 'string' && has(labels[key],value);
      } else if (colors.has(key)) {
        ok = typeof value === 'string' && (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ||
          (value === '' && ['earColor','limbColor'].includes(key)));
      } else if (typeof fallback === 'number') {
        const min = key === 'emotion' || key === 'browTilt' ? -1 : 0;
        ok = Number.isFinite(value) && value >= min && value <= 1;
      } else {
        ok = typeof value === 'boolean';
      }
      requireValue(ok, 'Недопустимая настройка мишки: ' + key);
      cfg[key] = key === 'acc' || key === 'clothes' ? [...value].sort() : value;
    }
    return cfg;
  }
  // Catalog records travel with the order. A later edit in CLOTHES must not change an old manufacturing sheet.
  function clothingSnapshot(ids, catalog, unitPrice) {
    requireValue(Array.isArray(catalog),'Некорректный каталог одежды.');
    const slotsUsed = new Set();
    const skusUsed = new Set();
    const picked = ids.map(id => {
      const entry = catalog.find(item => plain(item) && item.id === id);
      requireValue(entry,'В каталоге отсутствует выбранный предмет одежды: ' + id);
      const {slot, sku, price, color, label} = entry;
      requireValue(clothingSlots.includes(slot) && !slotsUsed.has(slot),'Два изделия в одном слоте одежды или неизвестный слот.');
      requireValue(typeof sku === 'string' && new RegExp('^CL-' + slot.toUpperCase() + '-[0-9]{3}$').test(sku) &&
        !skusUsed.has(sku),'Некорректный артикул одежды.');
      requireValue(typeof label === 'string' && label.trim() && label.length <= 100 &&
        !/[\u0000-\u001f\u007f]/.test(label),'Некорректное название одежды.');
      requireValue((typeof color === 'string' && /^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(color)) ||
        (Number.isSafeInteger(color) && color >= 0 && color <= 0xffffff),'Некорректный цвет одежды.');
      checkPrice(price);
      slotsUsed.add(slot);
      skusUsed.add(sku);
      return {id,slot,sku,price,color,label};
    });
    requireValue(picked.reduce((sum,item) => sum + item.price,0) <= unitPrice,'Одежда дороже общей суммы комплекта.');
    return picked.sort((a,b) => clothingSlots.indexOf(a.slot) - clothingSlots.indexOf(b.slot));
  }
  const slots = [
    ['COLOR','Цвет и плюш',null,null,'MAT'], ['BODY','Туловище','C',null,null],
    ['HEAD','Голова','C','BODY','J-NECK'], ['FACE','Мордочка','C','HEAD','F-FACE'],
    ['ARM_L','Левая рука','L','BODY','J-SHOULDER'], ['HAND_L','Левая кисть','L','ARM_L','J-WRIST'],
    ['ARM_R','Правая рука','R','BODY','J-SHOULDER'], ['HAND_R','Правая кисть','R','ARM_R','J-WRIST'],
    ['LEG_L','Левая нога','L','BODY','J-HIP'], ['FOOT_L','Левая стопа','L','LEG_L','J-ANKLE'],
    ['LEG_R','Правая нога','R','BODY','J-HIP'], ['FOOT_R','Правая стопа','R','LEG_R','J-ANKLE'],
    ['OUTFIT','Комплект одежды','C','BODY','WEAR']
  ];
  const percent = value => Math.round(value * 100) + '%';
  function describe(source, clothing = []) {
    const cfg = normalizeConfig(source);
    const label = key => labels[key][cfg[key]];
    const pick = keys => Object.fromEntries(keys.map(k => [k,cfg[k]]));
    const limb = cfg.limbColor || cfg.main;
    const usesParts = cfg.model === 'parts';
    const rows = {
      COLOR: [label('furType'), cfg.main + ' / ' + cfg.accent + ' · ' + label('pattern'),
        pick(['main','accent','furType','furLen','furDensity','pattern','patternColor','tip','tipMix','glbTint'])],
      BODY: [usesParts ? label('body') : label('model'), label('size') + ' · полнота ' + percent(cfg.bodyWidth) + ' · поза ' + label('pose'),
        pick(['model','body','bodyWidth','pose','size','belly','tail','name'])],
      HEAD: [usesParts ? label('headShape') : label('model'), 'Размер ' + percent(cfg.headSize) + ' · уши ' +
        (usesParts ? label('ears') : 'из 3D-модели') + ' · цвет ' + (cfg.earColor || cfg.main),
        pick(['headShape','headSize','ears','earPos','earSize','earColor','muzzleSize'])],
      FACE: ['Глаза: ' + label('eyes'), (usesParts ? 'Нос ' + label('noseType') + ' · рот ' + label('mouth') : 'Рот и нос из 3D-модели') +
        ' · цвет радужки ' + cfg.iris + (cfg.glow ? ' · свечение на экране' : ''),
        pick(['eyes','eyeSize','eyeSpacing','eyeHeight','iris','glow','nose','noseType','mouth','emotion','brows','browTilt','blush','eyeSpots'])],
      ARM: ['Рука · ' + limb, 'Длина ' + percent(cfg.armLen) + ' · толщина ' + percent(cfg.armThick),
        {color:limb, ...pick(['armLen','armThick','armPose'])}],
      HAND: ['Лапа · ' + limb, 'Подушечки ' + cfg.pads + (cfg.claws ? ' · когти' : ''),
        {color:limb, ...pick(['pads','claws'])}],
      LEG: ['Нога · ' + limb, 'Длина ' + percent(cfg.legLen) + ' · толщина ' + percent(cfg.legThick),
        {color:limb, ...pick(['legLen','legThick'])}],
      FOOT: ['Стопа · ' + limb, 'Подушечки ' + cfg.pads, {color:limb, pads:cfg.pads}],
      // Keep the original no-outfit row byte-compatible with exports from before the selector existed.
      OUTFIT: [label('outfit'), 'Аксессуары перечислены отдельно.', {outfit:cfg.outfit === 'base' ? null : cfg.outfit}]
    };
    if (cfg.clothes.length) {
      const items = clothingSnapshot(cfg.clothes,clothing,Infinity);
      rows.OUTFIT = [items.map(item => item.label).join(' + '), 'Одежда и обувь комплектуются отдельно от тела.',
        {clothes:items.map(item => item.id)}];
    }
    return slots.map(([slot, name, side, parent, joint], index) => {
      const [variant, description, attributes] = rows[slot.split('_')[0]];
      return {step:'ASM-' + String(index+1).padStart(2,'0'), slot, label:name, side, parent, joint, variant,
        description, attributes:{...attributes}, physical:slot === 'OUTFIT' && cfg.outfit === 'base' && !cfg.clothes.length ? 'none' : 'pending', sku:null};
    });
  }
  function layers(cfg) {
    return cfg.acc.map(id => ({id, label:accessories[id], layer:'LAYER_' + attachmentGroup[id].toUpperCase(), physical:'pending', sku:null}));
  }
  function makeId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || Array.from({length:4}, () => Math.random().toString(36).slice(2)).join('-');
    return prefix + '-' + id;
  }
  const newState = () => ({version, cart:[], orders:[]});
  function checkQuantity(value, minimum) {
    requireValue(Number.isInteger(value) && value >= minimum && value <= maxQuantity, 'Количество должно быть от ' + minimum + ' до ' + maxQuantity + '.');
  }
  function checkPrice(value) {
    requireValue(Number.isSafeInteger(value) && value >= 0 && value <= 1000000, 'Некорректная демонстрационная цена.');
  }
  function addItem(state, source, unitPrice, clothingCatalog = []) {
    const cfg = normalizeConfig(source);
    if (cfg.model === 'custom') throw new Error('Для заявки выберите встроенную модель: локальный 3D-файл нельзя передать в комплекте.');
    checkPrice(unitPrice);
    const clothing = clothingSnapshot(cfg.clothes,clothingCatalog,unitPrice);
    const same = state.cart.find(line => line.unitPrice === unitPrice && sameJson(line.cfg,cfg) && sameJson(line.clothing,clothing));
    if (same) return setQuantity(state,same.id,same.quantity+1);
    requireValue(state.cart.length < maxLines, 'В корзине уже ' + maxLines + ' разных комплектов.');
    const line = {id:makeId('item'), cfg, quantity:1, unitPrice, clothing};
    return {...state, cart:[...state.cart,line]};
  }
  function setQuantity(state, lineId, quantity) {
    checkQuantity(quantity,0);
    requireValue(state.cart.some(line => line.id === lineId), 'Комплект не найден в корзине.');
    const cart = quantity === 0 ? state.cart.filter(line => line.id !== lineId)
      : state.cart.map(line => line.id === lineId ? {...line,quantity} : line);
    return {...state,cart};
  }
  function checkDelivery(id) {
    requireValue(deliveries.some(fixture => fixture.id === id),'Выберите демонстрационный способ доставки.');
  }
  function lineSnapshot(line) {
    const cfg = normalizeConfig(line.cfg);
    const clothing = clothingSnapshot(cfg.clothes,line.clothing || [],line.unitPrice);
    return {...line, cfg, clothing, assembly:describe(cfg,clothing), accessories:layers(cfg)};
  }
  function createOrder(id, createdAt, deliveryId, cart) {
    const items = cart.map(lineSnapshot);
    const total = items.reduce((n,line) => n + line.quantity * line.unitPrice,0);
    return deepFreeze({id,createdAt,catalogVersion,deliveryId,items,total});
  }
  function checkout(state, deliveryId) {
    requireValue(state.cart.length > 0,'Добавьте мишку в корзину.');
    checkDelivery(deliveryId);
    requireValue(state.orders.length < maxOrders,'Заполнен журнал демозаявок.');
    const order = createOrder(makeId('BL'), new Date().toISOString(), deliveryId, state.cart);
    return {...state,cart:[],orders:[order,...state.orders]};
  }
  function checkId(value, prefix) {
    requireValue(typeof value === 'string' && value.startsWith(prefix + '-') && /^[a-zA-Z0-9-]{8,84}$/.test(value),'Некорректный идентификатор.');
  }
  function checkLines(lines, withDerived) {
    requireValue(Array.isArray(lines) && lines.length <= maxLines, 'Некорректное число комплектов.');
    const allowed = ['id','cfg','quantity','unitPrice','clothing'];
    if (withDerived) allowed.push('assembly','accessories');
    const ids = new Set();
    return lines.map(line => {
      assertKeys(line,allowed);
      checkId(line.id,'item');
      requireValue(!ids.has(line.id),'Повтор позиции в файле.');
      ids.add(line.id);
      checkQuantity(line.quantity,1);
      checkPrice(line.unitPrice);
      const cfg = normalizeConfig(line.cfg);
      requireValue(cfg.model !== 'custom','Локальная 3D-модель не поддерживается в файле заявки.');
      const rawClothing = has(line,'clothing') ? line.clothing : [];
      requireValue(Array.isArray(rawClothing) && rawClothing.length === cfg.clothes.length,'Снимок одежды не совпадает с выбранными изделиями.');
      rawClothing.forEach(item => assertKeys(item,['id','label','slot','sku','price','color']));
      const clothing = clothingSnapshot(cfg.clothes,rawClothing,line.unitPrice);
      return {id:line.id, cfg, quantity:line.quantity, unitPrice:line.unitPrice, clothing};
    });
  }
  function readOrder(raw, withDerived) {
    const fields = ['id','createdAt','catalogVersion','deliveryId','items'];
    if (withDerived) fields.push('total');
    assertKeys(raw,fields);
    checkId(raw.id,'BL');
    requireValue(raw.catalogVersion === catalogVersion,'Другая версия каталога в заявке.');
    requireValue(typeof raw.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.createdAt) &&
      Number.isFinite(Date.parse(raw.createdAt)) && new Date(raw.createdAt).toISOString() === raw.createdAt,'Некорректная дата заявки.');
    checkDelivery(raw.deliveryId);
    const lines = checkLines(raw.items,withDerived);
    requireValue(lines.length > 0,'Заявка без комплектов.');
    const order = createOrder(raw.id,raw.createdAt,raw.deliveryId,lines);
    if (withDerived) {
      requireValue(raw.total === order.total,'Итог заявки не совпадает с комплектацией.');
      for (const [index,line] of raw.items.entries()) {
        const rebuilt = order.items[index];
        requireValue(sameJson(line.assembly,rebuilt.assembly) && sameJson(line.accessories,rebuilt.accessories),
          'Состав заявки не совпадает с версией каталога.');
      }
    }
    return order;
  }
  // Compare only against the bounded canonical structure; JSON key enumeration order is immaterial.
  function sameJson(a,b) {
    if (a === b) return true;
    if (b === null || typeof b !== 'object' || a === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b) || Object.keys(a).length !== Object.keys(b).length) return false;
    return Object.keys(b).every(k => has(a,k) && sameJson(a[k],b[k]));
  }
  function parse(text,limit) {
    requireValue(typeof text === 'string' && text.length <= limit,'Слишком большой файл или неверный формат.');
    try { return JSON.parse(text); } catch (_) { throw new Error('Не удалось прочитать JSON.'); }
  }
  const envelope = order => ({type:'bearlab.demo-order',version,order});
  function exportOrder(order) {
    return JSON.stringify(envelope(order));
  }
  function importOrder(state, text) {
    const doc = parse(text,maxExportLength);
    assertKeys(doc,['type','version','order']);
    requireValue(doc.type === 'bearlab.demo-order' && doc.version === version,'Нужен файл демозаявки BearLab v1.');
    const order = readOrder(doc.order,true);
    const existing = state.orders.find(o => o.id === order.id);
    if (existing) {
      requireValue(sameJson(existing,order),'Такой номер уже существует с другим составом.');
      return state;
    }
    requireValue(state.orders.length < maxOrders,'Заполнен журнал демозаявок.');
    return {...state,orders:[order,...state.orders]};
  }
  function readState(storage = globalThis.localStorage) {
    const text = storage.getItem(storageKey);
    if (text === null) return newState();
    const raw = parse(text,5000000);
    assertKeys(raw,['version','cart','orders']);
    requireValue(raw.version === version && Array.isArray(raw.orders) && raw.orders.length <= maxOrders,'Неподдерживаемый журнал демозаявок.');
    const orders = raw.orders.map(o => readOrder(o,false));
    requireValue(new Set(orders.map(o => o.id)).size === orders.length,'Номер заявки встречается дважды.');
    return {version,cart:checkLines(raw.cart,false),orders};
  }
  function writeState(state, storage = globalThis.localStorage) {
    // Persist source snapshots compactly. Never refresh their price or config from the active editor.
    const orders = state.orders.map(({id,createdAt,catalogVersion,deliveryId,items}) => ({
      id,createdAt,catalogVersion,deliveryId,items:items.map(({id,cfg,quantity,unitPrice,clothing}) => ({id,cfg,quantity,unitPrice,clothing}))
    }));
    storage.setItem(storageKey,JSON.stringify({version,cart:state.cart,orders}));
  }
  return Object.freeze({version,catalogVersion,storageKey,deliveries:deepFreeze(deliveries),readState,writeState,
    addItem,setQuantity,checkout,exportOrder,importOrder,describe});
});
