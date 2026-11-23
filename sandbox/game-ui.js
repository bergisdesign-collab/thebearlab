/* Local virtual-pet presentation. Dima's configuration remains the source of truth. */
window.BearLabGame={install(api){
  const {e,art,go,icon}=api;
  const KEY='bearlab.pet.v1';
  const Life=window.BearLabLifeModel;
  let pet=Life.normalize(null);
  try{pet=Life.normalize(JSON.parse(localStorage.getItem(KEY)||'null'))}catch(_){}
  const persist=()=>{try{localStorage.setItem(KEY,JSON.stringify(pet));return true}catch(_){api.toast('Браузер не разрешил сохранить прогресс');return false}};
  function dispatch(action){const result=Life.transact(pet,action);if(!result.ok)return result;const previous=pet;pet=result.state;if(!persist()){pet=previous;return {...result,ok:false,message:'Не удалось сохранить. Действие не выполнено.'}}return result}
  const icons={food:0,games:1,wardrobe:2,world:3,home:4,collection:5,workshop:6,shop:7,backpack:8,gift:9,tasks:10,star:11,coin:12,heart:13,settings:14,honey:15};
  const gi=(name,cls='')=>e('span',{class:'gm-icon '+cls,'aria-hidden':'true',style:`--gx:${(icons[name]??11)%4*100/3}%;--gy:${Math.floor((icons[name]??11)/4)*100/3}%`});
  const b=(label,fn,cls='',children=[])=>e('button',{type:'button',class:cls,onclick:fn,'aria-label':label},children.length?children:label);
  const number=n=>new Intl.NumberFormat('ru-RU').format(n);
  const progress=(label,value,kind='')=>e('div',{class:'gm-meter '+kind},[e('span',{},label),e('b',{},Math.min(100,value)+'%'),e('div',{role:'progressbar','aria-label':label,'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':Math.min(100,value)},e('i',{style:`width:${Math.min(100,value)}%`}))]);
  let dialog=null,returnFocus=null;
  function close(){dialog?.remove();dialog=null;returnFocus?.isConnected&&returnFocus.focus()}
  function open(title,children,kind=''){
    if(!dialog)returnFocus=document.activeElement;
    dialog?.remove();
    const titleId='gm-dialog-title';
    const panel=e('section',{class:'gm-sheet '+kind,role:'dialog','aria-modal':'true','aria-labelledby':titleId},[
      e('header',{class:'gm-sheet-head'},[e('h2',{id:titleId},title),b('Закрыть',close,'gm-close','×')]),
      e('div',{class:'gm-sheet-content'},children)
    ]);
    dialog=e('div',{class:'gm-overlay',onclick:ev=>{if(ev.target===dialog)close()}},panel);document.body.append(dialog);
    panel.addEventListener('keydown',ev=>{if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();close()}if(ev.key==='Tab'){const all=[...panel.querySelectorAll('button,input,select,a[href]')].filter(n=>!n.disabled);if(ev.shiftKey&&document.activeElement===all[0]){ev.preventDefault();all.at(-1)?.focus()}else if(!ev.shiftKey&&document.activeElement===all.at(-1)){ev.preventDefault();all[0]?.focus()}}});
    panel.querySelector('button')?.focus();
  }
  function navigate(id){if(id==='games')id='arcade';close();if(id==='world'){pet.explored=true;persist()}go(id)}
  const action=(label,name,fn,cls='')=>b(label,fn,'gm-action '+cls,[gi(name),e('strong',{},label)]);
  const primary=(label,fn)=>b(label,fn,'gm-primary');
  let status;
  function hud(){return e('header',{class:'gm-hud'},[
    b('Состояние мишки',status,'gm-profile',[e('span',{class:'gm-avatar'},art(api.config(),true)),e('span',{},[e('strong',{},'Ур. '+(12+Math.floor(pet.xp/500))),e('span',{class:'gm-xp'},e('i',{style:`width:${pet.xp%500/5}%`}))])]),
    b('BearLab — домой',()=>navigate('home'),'gm-logo',[e('small',{},'THE'),e('span',{},['BE',e('em',{},'A'),'R',e('b',{},'LAB')])]),
    b('Баланс: '+number(pet.coins)+' монет и '+number(pet.stars)+' звёзд',wallet,'gm-wallet',[...['coin','star'].map((i,n)=>e('span',{class:'gm-currency'},[gi(i),e('b',{},number(n?pet.stars:pet.coins)),e('span',{class:'gm-plus'},'+')]))]),
  ])}
  let wallet;
  let feed;
  const missions=()=>[['fed','Угостить мишку','Поделитесь чем-нибудь вкусным','food',feed],['styled','Подобрать новый образ','Примерьте вещь в гардеробе','wardrobe',()=>navigate('wardrobe')],['explored','Заглянуть в город','Откройте карту маленького мира','world',()=>navigate('world')]];
  function tasks(){const done=missions().filter(([key])=>pet[key]).length;open('Маленькие приключения',[
    e('p',{class:'gm-lead'},'Три простых дела для большого дня.'),
    e('div',{class:'gm-task-list'},missions().map(([key,title,desc,i,fn])=>b(title,fn,'gm-task',[gi(i),e('span',{},[e('strong',{},title),e('small',{},desc)]),e('b',{class:pet[key]?'gm-done':''},pet[key]?'✓':'›')]))),
    e('div',{class:'gm-task-reward'},[gi('gift'),e('span',{},[e('strong',{},'Награда: 150 монет'),e('small',{},`${done} из 3 заданий выполнено`)])]),
    e('button',{type:'button',class:'gm-primary',disabled:done<3||pet.claimed?'':null,onclick:()=>{if(done<3||pet.claimed)return;pet.claimed=true;pet.coins+=150;pet.stars+=3;pet.xp+=60;persist();close();api.render();api.toast('Задания выполнены! +150 монет и +3 звезды')}},pet.claimed?'Награда получена':done===3?'Забрать награду':'Выполните все три задания')
  ])}
  function gift(){open(pet.gift?'Подарок уже у вас':'Сюрприз для друга',[
    gi('gift','gm-big-icon'),e('h3',{class:'gm-centered'},pet.gift?'До новых приключений!':'100 монет в подарок'),e('p',{class:'gm-lead'},pet.gift?'Следующая награда ждёт за выполнение заданий.':'Добро пожаловать в маленький мир вашего мишки.'),
    primary(pet.gift?'Открыть задания':'Забрать подарок',()=>{if(pet.gift){tasks();return}pet.gift=true;pet.coins+=100;pet.xp+=20;persist();close();api.render();api.toast('Подарок ваш! +100 монет')})
  ])}
  let season;
  let collection;
  let shop;
  let backpack;
  function nav(active='home'){return e('nav',{class:'gm-nav','aria-label':'Игровые разделы'},[
    ['home','Дом',()=>navigate('home')],['collection','Коллекция',collection],['workshop','Лаборатория',()=>navigate('workshop')],['shop','Магазин',shop],['backpack','Рюкзак',backpack]
  ].map(([i,l,fn])=>{const n=b(l,fn,'gm-nav-item',[gi(i),e('span',{},l)]);if(i===active)n.setAttribute('aria-current','page');return n}))}
  function home(){return e('div',{class:'cx-view gm-home','data-concept':'home'},[
    e('div',{class:'gm-scenery','aria-hidden':'true'}),hud(),
    b('Маленькие открытия',season,'gm-season',[gi('collection'),e('span',{},[e('strong',{},'Маленькие открытия'),e('small',{},'Палитры, задания и забота о друге')]),e('b',{},'›')]),
    e('div',{class:'gm-side gm-left'},[action('Награды','gift',gift,pet.gift?'':'gm-unread')]),
    e('div',{class:'gm-side gm-right'},[action('Задания','tasks',tasks),action('События','star',season)]),
    e('div',{class:'gm-pet-space'},[e('div',{class:'gm-pet-shadow'}),e('div',{class:'gm-pet cx-hero'},art(api.config())),b('Погладить мишку',()=>{pet.mood=Math.min(100,pet.mood+2);persist();api.treat()},'gm-pet-touch'),e('div',{class:'gm-pet-name'},[e('strong',{},api.config().name||'Мой мишка'),b('Выбрать мишку',chooseBear,'gm-change-bear')])]),
    e('div',{class:'gm-main-actions'},[action('Кормить','food',feed,'mint'),action('Играть','games',()=>navigate('games'),'purple'),action('Одеть','wardrobe',()=>navigate('wardrobe'),'pink'),action('Исследовать','world',()=>navigate('world'),'mint')]),nav()
  ])}
  function top(title){return e('header',{class:'gm-page-top'},[b('Домой',()=>navigate('home'),'gm-back',[icon('home')]),e('h1',{},title),b('Рюкзак',backpack,'gm-top-bag',[gi('backpack')])])}
  function world(){return e('div',{class:'cx-view gm-world','data-concept':'world'},[
    top('Маленький мир'),e('div',{class:'gm-world-map'},[
      e('img',{src:'assets/demo/world.png',alt:'Городок мишки с мастерской, гардеробом и игровым павильоном'}),
      ...[['workshop','Лаборатория','Цвет и характер'],['wardrobe','Студия стиля','Примерьте новый образ'],['games','Игровой клуб','Три мини-игры']].map(([id,l,desc])=>b(l,()=>navigate(id),'gm-place gm-place-'+id,[gi(id),e('span',{},[e('strong',{},l),e('small',{},desc)]),e('b',{},'›')]))
    ]),e('p',{class:'gm-map-hint'},'Выберите место — приключение уже ждёт'),e('div',{class:'gm-world-guide'},[['workshop','Лаборатория','Создать своего мишку'],['wardrobe','Студия стиля','Найти любимый образ'],['games','Игровой клуб','Логика, память и маршруты']].map(([id,label,desc])=>b(label,()=>navigate(id),'gm-world-card',[gi(id),e('strong',{},label),e('small',{},desc)]))),nav('')
  ])}
  function comfort(){
    const prefs=api.preferences();
    const toggle=(label,key,on,off)=>b(label,()=>{api.comfort({[key]:!prefs[key]});comfort();document.querySelector('.gm-sheet [aria-label="'+label+'"]')?.focus()},'gm-comfort-option',[e('span',{},label),e('b',{},prefs[key]?on:off)]);
    open('Удобно играть',[
      prefs.motionLocked?e('p',{class:'gm-note'},'Меньше движения включено в настройках вашего устройства.'):toggle('Меньше движения','motion','Выкл','Вкл'),
      toggle('Крупнее кнопки','largeTargets','Вкл','Выкл'),
      b('Ведущая рука',()=>{api.comfort({hand:prefs.hand==='left'?'right':'left'});comfort();document.querySelector('.gm-sheet [aria-label="Ведущая рука"]')?.focus()},'gm-comfort-option',[e('span',{},'Ведущая рука'),e('b',{},prefs.hand==='left'?'Левая':'Правая')]),
      e('p',{class:'gm-note'},'Настройки сохраняются на этом устройстве. Ведущая рука меняет расположение кнопок в горизонтальной игре.'),
      e('div',{class:'gm-key-guide'},[e('h3',{},'С клавиатурой'),...[
        ['Tab / Shift + Tab','Следующая / предыдущая кнопка'],['Enter / Пробел','Нажать выбранную кнопку'],['Стрелки','Перемещение по полю «Три в ряд»'],['Alt + 1 / 2 / 3 / 4','Кормить / играть / одеть / мир'],['Alt + Home','Домой'],['Esc','Закрыть окно']
      ].map(([key,label])=>e('p',{},[e('kbd',{},key),e('span',{},label)]))])
    ]);
  }
  document.addEventListener('keydown',ev=>{
    if(document.body.dataset.theme!=='game'||ev.defaultPrevented||ev.repeat||!ev.altKey||ev.ctrlKey||ev.metaKey||ev.shiftKey||ev.isComposing)return;
    if(document.activeElement?.matches('input,textarea,select,[contenteditable]')||dialog||!document.getElementById('cx-admin').hidden||!document.getElementById('modal').hidden)return;
    const fn={Digit1:feed,Digit2:()=>navigate('games'),Digit3:()=>navigate('wardrobe'),Digit4:()=>navigate('world'),Home:()=>navigate('home')}[ev.code];
    if(fn){ev.preventDefault();fn();if(!dialog)document.querySelector('#concept button')?.focus()}
  });
  let previousScreen;
  function sync(){if(document.body.dataset.theme==='game'&&!document.querySelector('.gm-comfort-launch')){const launch=b('Удобство и управление',comfort,'gm-comfort-launch',[icon('comfort'),e('span',{},'Удобство')]);document.body.append(launch)}document.querySelector('.gm-comfort-launch')?.toggleAttribute('hidden',document.body.dataset.theme!=='game'||document.body.dataset.screen!=='home');const screen=document.body.dataset.screen;if(screen!==previousScreen)document.getElementById('cx-toast')?.classList.remove('on');previousScreen=screen;if(document.body.dataset.theme!=='game')close()}
  function reward(score,runId,gameId='match3'){const r=dispatch({type:'reward',gameId,runId,score});if(!r.ok&&!pet.rewardedRuns.includes(runId))throw new Error(r.message);return r.reward?.coins||0}
  const gem=index=>gi(['star','workshop','coin','heart','honey'][index]);
  const closet=window.BearLabWardrobe.install({...api,config:api.config,go:navigate,open,close,nav,styled:()=>{pet.styled=true;persist()}});
  collection=closet.collection;
  const arcade=window.BearLabArcade.install({e,render:api.render,home:()=>navigate('home'),playMatch3:api.playMatch3,match3Progress:api.match3Progress,reward:r=>reward(r.score,r.runId,r.gameId),playerName:()=>api.config().name,nav,icon,art,config:api.config,toast:api.toast,canStart:r=>canStart(r),energy:()=>({value:pet.energy,cost:10}),rest:()=>rest()});
  function canStart(r){const result=dispatch({type:'startGame',...r});if(!result.ok){open('Нужно немного отдыха',[e('p',{class:'gm-lead'},result.message),primary('Отдохнуть бесплатно',()=>{rest();close();api.render()}),b('Домой',()=>navigate('home'),'gm-secondary')]);return false}return true}
  function rest(){const r=dispatch({type:'rest'});api.toast(r.message)}
  const life=window.BearLabLife.install({e,gi,art,config:api.config,open,close,toast:api.toast,getState:()=>pet,dispatch,render:api.render,go:navigate,treat:api.treat,applyReward:update=>{api.patchConfig(update)}});
  status=life.status;feed=life.feed;backpack=life.inventory;
  shop=function(){open('Лавка мишки',[
    e('div',{class:'gm-shop-intro'},[gi('shop'),e('div',{},[e('h3',{},'Всё для вашего друга'),e('p',{},'Угощения для игры и настоящий мишка в вашем образе.')])]),
    primary('Еда, вода и уход',life.market),b('Капсула вдохновения',life.capsule,'gm-secondary'),
    e('hr'),e('h3',{},'Настоящий мишка'),e('p',{class:'gm-note'},'Ваш образ можно перенести в демонстрационную заявку. Состав и цена требуют проверки производства.'),
    b('Собрать физического мишку',()=>navigate('look'),'gm-secondary'),b('Открыть корзину',()=>navigate('cart'),'gm-secondary')
  ])};
  wallet=function(){open('Монеты и звёзды',[
    e('div',{class:'gm-wallet-summary'},[e('div',{},[gi('coin'),e('b',{},number(pet.coins)),e('span',{},'монет на заботу')]),e('div',{},[gi('star'),e('b',{},number(pet.stars)),e('span',{},'всего звёзд')])]),
    e('p',{class:'gm-lead'},'Играйте, зарабатывайте и заботьтесь о мишке.'),primary('Заработать в мини-играх',()=>navigate('arcade')),b('Купить еду и воду',life.market,'gm-secondary'),b('Открыть новую палитру',life.capsule,'gm-secondary'),e('p',{class:'gm-note'},'Для капсул заработано '+pet.earnedStars+' звёзд. Начальные демонстрационные звёзды в капсулах не тратятся. Покупки валюты за деньги нет.')
  ])};
  season=function(){open('Мастерская маленьких открытий',[
    e('div',{class:'gm-season-art'},[gi('collection'),gi('wardrobe'),gi('gift')]),e('p',{class:'gm-lead'},'Новая палитра, любимый образ и забота о друге.'),
    primary('Открыть палитры',life.capsule),b('Задания и награды',tasks,'gm-secondary'),b('Салон красок',salon,'gm-secondary'),b('Выбрать мишку',chooseBear,'gm-secondary')
  ])};
  let bearUndo=null;
  function chooseBear(){const c=api.config();open('Выберите своего мишку',[
    e('p',{class:'gm-lead'},'Все 12 исходных характеров. После выбора можно изменить каждую деталь в лаборатории.'),
    e('div',{class:'gm-bear-choice'},[e('div',{class:'gm-choice-preview'},art(c)),e('div',{class:'gm-preset-list'},api.presets.map((p,i)=>b(p.name,()=>{bearUndo=JSON.parse(JSON.stringify(api.config()));api.applyPreset(i);api.render();chooseBear()},'gm-preset-choice',[e('strong',{},p.name),e('small',{},p.d)])))]),
    bearUndo?b('Вернуть предыдущего мишку',()=>{api.restoreConfig(bearUndo);bearUndo=null;api.render();chooseBear()},'gm-secondary'):null,
    primary('Готово — домой',()=>navigate('home')),b('Все детали в лаборатории',()=>navigate('workshop'),'gm-secondary')
  ],'gm-wide')}
  function salon(){const c=api.config();open('Салон красок',[
    e('div',{class:'gm-profile-art'},art(c)),e('p',{class:'gm-lead'},'Мех, узоры и румянец. Все изменения сразу видны на вашем мишке.'),
    e('div',{class:'gm-salon-colors'},[['Мёд','#c98b4f'],['Крем','#f5efe6'],['Лаванда','#b197d0'],['Розовый','#ffc7de'],['Мята','#68c8b4'],['Ночь','#2b2b2e']].map(([label,color])=>b(label,()=>{bearUndo=JSON.parse(JSON.stringify(c));api.patchConfig({main:color});api.render();salon()},'gm-salon-swatch',[e('i',{style:'background:'+color}),e('span',{},label)]))),
    e('div',{class:'gm-salon-patterns'},[['none','Без узора'],['hearts','Сердечки'],['stars','Звёздочки'],['spots','Пятнышки'],['stripes','Полоски']].map(([pattern,label])=>e('button',{type:'button',class:'gm-secondary','aria-pressed':String(c.pattern===pattern),onclick:()=>{bearUndo=JSON.parse(JSON.stringify(c));api.patchConfig({pattern});api.render();salon()}},label))),
    b(c.blush?'Убрать румянец':'Добавить румянец',()=>{bearUndo=JSON.parse(JSON.stringify(c));api.patchConfig({blush:!c.blush});api.render();salon()},'gm-secondary'),
    bearUndo?b('Отменить изменение',()=>{api.restoreConfig(bearUndo);bearUndo=null;api.render();salon()},'gm-secondary'):null,
    primary('Готово — домой',()=>navigate('home')),b('Точная настройка цветов',()=>navigate('workshop'),'gm-secondary')
  ])}
  let activeAt=Date.now();setInterval(()=>{const now=Date.now(),seconds=Math.min(15,Math.floor((now-activeAt)/1000));activeAt=now;if(!document.hidden&&document.hasFocus()&&document.body.dataset.theme==='game')dispatch({type:'tick',active:true,seconds})},15000);
  window.addEventListener('storage',event=>{if(event.key===KEY){try{pet=Life.normalize(JSON.parse(event.newValue))}catch(_){}}});
  function demoControls(){const values={...pet};const fields=[['coins','Монеты',999999],['stars','Всего звёзд',999999],['earnedStars','Заработанные звёзды',999999],['energy','Энергия',100],['food','Сытость',100],['thirst','Вода',100],['hygiene','Чистота',100],['mood','Настроение',100]];
    return e('details',{class:'gm-demo-controls'},[e('summary',{},'Тестовое состояние игры'),e('p',{},'Для проверки сценариев: нехватка энергии, покупка еды, открытие капсулы. Меняет только данные этого браузера.'),e('div',{class:'gm-demo-fields'},fields.map(([key,label,max])=>e('label',{},[label,e('input',{type:'number',min:0,max,value:pet[key],'aria-label':'Тест: '+label,oninput:event=>{values[key]=Number(event.target.value)}})]))),b('Применить тестовое состояние',()=>{pet=Life.normalize({...pet,...Object.fromEntries(fields.map(([key])=>[key,values[key]]))});persist();api.render();api.toast('Тестовые показатели применены')},'gm-secondary')])
  }
  return {home,wardrobe:closet.view,world,sync,close,nav,reward,gem,arcade:arcade.view,openArcadeLobby:arcade.openLobby,recordMatch3:arcade.recordMatch3,canStart,demoControls,confirmRestart:callback=>open('Начать новый раунд?',[e('p',{class:'gm-lead'},'Текущее поле сбросится. Новый раунд стоит 10 энергии.'),primary('Да, новый раунд',()=>{close();callback()}),b('Продолжить этот раунд',close,'gm-secondary')])};
}};
