/* Local virtual-pet presentation. Dima's configuration remains the source of truth. */
window.BearLabGame={install(api){
  const {e,art,go,icon}=api;
  const KEY='bearlab.pet.v1';
  const defaults={coins:4250,stars:320,food:72,mood:86,energy:80,xp:240,gift:false,claimed:false,fed:false,styled:false,explored:false};
  let pet={...defaults};
  try{const saved=JSON.parse(localStorage.getItem(KEY)||'null');if(saved&&typeof saved==='object')for(const k of Object.keys(defaults)){if(typeof saved[k]===typeof defaults[k])pet[k]=typeof saved[k]==='number'?Math.max(0,Math.min(999999,Math.round(saved[k]))):saved[k]}}catch(_){}
  const persist=()=>{try{localStorage.setItem(KEY,JSON.stringify(pet))}catch(_){api.toast('Браузер не разрешил сохранить прогресс')}};
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
  function navigate(id){close();if(id==='world'){pet.explored=true;persist()}go(id)}
  const action=(label,name,fn,cls='')=>b(label,fn,'gm-action '+cls,[gi(name),e('strong',{},label)]);
  const primary=(label,fn)=>b(label,fn,'gm-primary');
  function status(){open(api.config().name||'Мой мишка',[
    e('div',{class:'gm-profile-art'},art(api.config())),e('p',{class:'gm-lead'},'Маленькая забота — большое счастье.'),
    progress('Сытость',pet.food,'mint'),progress('Настроение',pet.mood,'pink'),progress('Энергия',pet.energy,'gold'),
    primary('Отдохнуть вместе',()=>{pet.energy=Math.min(100,pet.energy+20);pet.mood=Math.min(100,pet.mood+5);persist();api.toast('Хорошо отдохнули! Энергия +20');status()}),
    b('Настроить мишку',()=>navigate('workshop'),'gm-secondary')
  ])}
  function hud(){return e('header',{class:'gm-hud'},[
    b('Состояние мишки',status,'gm-profile',[e('span',{class:'gm-avatar'},art(api.config(),true)),e('span',{},[e('strong',{},'Ур. '+(12+Math.floor(pet.xp/500))),e('span',{class:'gm-xp'},e('i',{style:`width:${pet.xp%500/5}%`}))])]),
    b('BearLab — домой',()=>navigate('home'),'gm-logo',[e('small',{},'THE'),e('span',{},['BE',e('em',{},'A'),'R',e('b',{},'LAB')])]),
    b('Баланс: '+number(pet.coins)+' монет и '+number(pet.stars)+' звёзд',wallet,'gm-wallet',[...['coin','star'].map((i,n)=>e('span',{class:'gm-currency'},[gi(i),e('b',{},number(n?pet.stars:pet.coins)),e('span',{class:'gm-plus'},'+')]))]),
  ])}
  function wallet(){open('Мои награды',[
    e('div',{class:'gm-wallet-summary'},[e('div',{},[gi('coin'),e('b',{},number(pet.coins)),e('span',{},'монет')]),e('div',{},[gi('star'),e('b',{},number(pet.stars)),e('span',{},'звёзд')])]),
    e('p',{class:'gm-lead'},'Заботьтесь о мишке и выполняйте задания, чтобы получать награды.'),
    primary('Открыть задания',tasks),e('p',{class:'gm-note'},'Демонстрационный баланс. Покупок за реальные деньги нет.')
  ])}
  function feed(){open('Время вкусненького',[
    e('p',{class:'gm-lead'},'Чем угостим мишку?'),progress('Сытость',pet.food,'mint'),
    e('div',{class:'gm-foods'},[['food','Хрустящие шарики',12],['honey','Медовый десерт',18]].map(([i,l,n])=>b(l,()=>{const before=pet.food;pet.food=Math.min(100,pet.food+n);pet.mood=Math.min(100,pet.mood+3);pet.fed=true;persist();close();api.render();api.treat();api.toast(before>=100?'Мишка сыт и рад вашему вниманию!':'Вкусно! Сытость +'+(pet.food-before))},'gm-food',[gi(i),e('strong',{},l),e('small',{},'Сытость +'+n)]))),
    e('p',{class:'gm-note'},'Угощения в демоверсии доступны бесплатно.')
  ])}
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
  function season(){open('Сезон тёплых историй',[
    e('div',{class:'gm-season-art'},[gi('collection'),gi('wardrobe'),gi('gift')]),
    e('p',{class:'gm-lead'},'Уютный образ, любимые занятия и время вместе.'),
    e('div',{class:'gm-season-steps'},[e('p',{},'01 · Позаботьтесь о мишке'),e('p',{},'02 · Соберите любимый образ'),e('p',{},'03 · Откройте маленький мир')]),
    primary('Начать приключение',tasks)
  ])}
  function collection(){open('Моя коллекция',[
    e('p',{class:'gm-lead'},'Три образа. Три маленькие истории.'),
    e('div',{class:'gm-collection'},api.outfits.map((o,i)=>b(o.name,()=>{api.setClothes(o.clothes.slice());pet.styled=true;persist();navigate('wardrobe')},'gm-collect-card',[art({...api.config(),clothes:o.clothes},false,true),e('small',{},['ПЕРВАЯ ИСТОРИЯ','ГОРОДСКОЙ ДРУГ','ТЁПЛЫЙ ДЕНЬ'][i]||'МОЯ ИСТОРИЯ'),e('strong',{},o.name),e('span',{},'Примерить ›')]))),
    e('p',{class:'gm-note'},'Все три комплекта доступны для примерки.')
  ],'gm-wide')}
  function shop(){open('Лавка мишки',[
    e('div',{class:'gm-shop-intro'},[gi('shop'),e('div',{},[e('h3',{},'Из игры — в объятия'),e('p',{},'Соберите свой образ и посмотрите, каким может стать настоящий мишка.')])]),
    primary('Выбрать одежду',()=>navigate('wardrobe')),b('Посмотреть моего мишку',()=>navigate('look'),'gm-secondary'),
    b('Открыть корзину',()=>navigate('cart'),'gm-secondary'),e('p',{class:'gm-note'},'Это примерка и демонстрационная заявка. Цены требуют согласования с производством. Оплаты нет.')
  ])}
  function backpack(){const clothes=api.catalog.filter(it=>api.config().clothes.includes(it.id));open('Мой рюкзак',[
    e('p',{class:'gm-lead'},'Всё для маленького приключения.'),
    e('div',{class:'gm-bag-items'},[b('Угощения',feed,'gm-bag-item',[gi('food'),e('strong',{},'Угощения'),e('small',{},'Всегда с собой')]),b('Мой образ',()=>navigate('wardrobe'),'gm-bag-item',[gi('wardrobe'),e('strong',{},'Мой образ'),e('small',{},clothes.length?clothes.map(it=>it.label).join(', '):'Без одежды')]),b('Мои коллекции',collection,'gm-bag-item',[gi('collection'),e('strong',{},'Коллекции'),e('small',{},'3 доступных образа')])]),
    b('Поделиться мишкой',()=>navigate('share'),'gm-secondary'),b('Мои демозаявки',()=>navigate('orders'),'gm-secondary')
  ])}
  function nav(active='home'){return e('nav',{class:'gm-nav','aria-label':'Игровые разделы'},[
    ['home','Дом',()=>navigate('home')],['collection','Коллекция',collection],['workshop','Лаборатория',()=>navigate('workshop')],['shop','Магазин',shop],['backpack','Рюкзак',backpack]
  ].map(([i,l,fn])=>{const n=b(l,fn,'gm-nav-item',[gi(i),e('span',{},l)]);if(i===active)n.setAttribute('aria-current','page');return n}))}
  function home(){return e('div',{class:'cx-view gm-home','data-concept':'home'},[
    e('div',{class:'gm-scenery','aria-hidden':'true'}),hud(),
    b('Сезон тёплых историй',season,'gm-season',[gi('collection'),e('span',{},[e('strong',{},'Сезон тёплых историй'),e('small',{},'Наряды, задания и маленькие открытия')]),e('b',{},'›')]),
    e('div',{class:'gm-side gm-left'},[action('Награды','gift',gift,pet.gift?'':'gm-unread')]),
    e('div',{class:'gm-side gm-right'},[action('Задания','tasks',tasks),action('События','star',season)]),
    e('div',{class:'gm-pet-space'},[e('div',{class:'gm-pet-shadow'}),e('div',{class:'gm-pet cx-hero'},art(api.config())),b('Погладить мишку',()=>{pet.mood=Math.min(100,pet.mood+2);persist();api.treat()},'gm-pet-touch'),e('div',{class:'gm-pet-name'},[e('strong',{},api.config().name||'Мой мишка'),e('span',{},'Рад быть рядом')])]),
    e('div',{class:'gm-main-actions'},[action('Кормить','food',feed,'mint'),action('Играть','games',()=>navigate('games'),'purple'),action('Одеть','wardrobe',()=>navigate('wardrobe'),'pink'),action('Исследовать','world',()=>navigate('world'),'mint')]),nav()
  ])}
  function top(title){return e('header',{class:'gm-page-top'},[b('Домой',()=>navigate('home'),'gm-back','‹'),e('h1',{},title),b('Рюкзак',backpack,'gm-top-bag',[gi('backpack')])])}
  let category='all';
  function wardrobe(){const c=api.config();const restore=(selector,label)=>{[...document.querySelectorAll(selector)].find(n=>n.getAttribute('aria-label')===label)?.focus({preventScroll:true})};const repaint=(selector,label)=>{const positions=['.gm-dressing','.gm-closet'].map(q=>[q,document.querySelector(q)?.scrollTop||0]);api.render();for(const [q,y]of positions){const node=document.querySelector(q);if(node)node.scrollTop=y}restore(selector,label)};const choose=(ids,label,selector)=>{api.setClothes(ids);pet.styled=true;persist();repaint(selector,label)};const shown=api.catalog.filter(it=>category==='all'||it.slot===category);return e('div',{class:'cx-view gm-wardrobe','data-concept':'wardrobe'},[
    top('Гардероб'),e('div',{class:'gm-dressing'},[
      e('section',{class:'gm-fitting'},[e('div',{class:'gm-fitting-glow'}),e('div',{class:'gm-dressed cx-hero'},art(c)),e('div',{class:'gm-fit-name'},[e('strong',{},c.name||'Мой мишка'),e('small',{},'Ваш стиль. Ваша история.')]),b('Цвет и детали',()=>navigate('workshop'),'gm-fit-edit')]),
      e('section',{class:'gm-closet'},[
        e('h2',{},'Любимые образы'),e('div',{class:'gm-outfits'},api.outfits.map(o=>{const n=b(o.name,()=>choose(o.clothes.slice(),o.name,'.gm-outfit'),'gm-outfit',[art({...c,clothes:o.clothes},false,true),e('strong',{},o.name)]);n.setAttribute('aria-pressed',String(c.clothes.length===o.clothes.length&&c.clothes.every(x=>o.clothes.includes(x))));return n})),
        e('h2',{},'Сочетайте по-своему'),e('div',{class:'gm-categories',role:'group','aria-label':'Категории одежды'},[['all','Всё'],['top','Одежда'],['feet','Обувь']].map(([id,l])=>{const n=b(l,()=>{category=id;repaint('.gm-categories button',l)},'');n.setAttribute('aria-pressed',String(id===category));return n})),
        e('div',{class:'gm-garments'},shown.map(it=>{const n=b(it.label,()=>{let ids=c.clothes.filter(id=>id!==it.id);if(!c.clothes.includes(it.id))ids=ids.filter(id=>api.catalog.find(x=>x.id===id)?.slot!==it.slot).concat(it.id);choose(ids,it.label,'.gm-garment')},'gm-garment',[e('span',{class:'gm-garment-symbol'},icon(it.slot==='feet'?'spark':'wardrobe')),e('span',{},it.label),e('b',{},c.clothes.includes(it.id)?'✓':'+')]);n.setAttribute('aria-pressed',String(c.clothes.includes(it.id)));return n})),
        primary('Готово — мой образ',()=>navigate('look')),e('p',{class:'gm-note'},'Примерка бесплатна. Выбранные вещи сохраняются.')
      ])
    ]),nav('collection')
  ])}
  function world(){return e('div',{class:'cx-view gm-world','data-concept':'world'},[
    top('Маленький мир'),e('div',{class:'gm-world-map'},[
      e('img',{src:'assets/demo/world.png',alt:'Городок мишки с мастерской, гардеробом и игровым павильоном'}),
      ...[['workshop','Лаборатория','Цвет и характер'],['wardrobe','Студия стиля','Примерьте новый образ'],['games','Игровой клуб','Три в ряд']].map(([id,l,desc])=>b(l,()=>navigate(id),'gm-place gm-place-'+id,[gi(id),e('span',{},[e('strong',{},l),e('small',{},desc)]),e('b',{},'›')]))
    ]),e('p',{class:'gm-map-hint'},'Выберите место — приключение уже ждёт'),e('div',{class:'gm-world-guide'},[['workshop','Лаборатория','Создать своего мишку'],['wardrobe','Студия стиля','Найти любимый образ'],['games','Игровой клуб','Собрать три в ряд']].map(([id,label,desc])=>b(label,()=>navigate(id),'gm-world-card',[gi(id),e('strong',{},label),e('small',{},desc)]))),nav('')
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
  function reward(score){const amount=Math.max(10,Math.min(200,Math.floor(score/10)));pet.coins+=amount;pet.xp+=30;pet.mood=Math.min(100,pet.mood+10);persist();return amount}
  const gem=index=>gi(['star','workshop','coin','heart','honey'][index]);
  return {home,wardrobe,world,sync,close,nav,reward,gem};
}};
