/* Presentation layer over Dima's configuration and order engine. No duplicate app state. */
window.BearLabStudio={install(api){
  const e=(tag,attrs={},children=[])=>{const n=document.createElement(tag);for(const [k,v] of Object.entries(attrs)){if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else if(v!=null)n.setAttribute(k,String(v))}for(const c of [children].flat(Infinity)){if(c!=null)n.append(c instanceof Node?c:document.createTextNode(String(c)))}return n};
  const paths={comfort:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',home:'M3 10 12 3l9 7v10H3Z M9 20v-7h6v7',wardrobe:'m8 3-5 4 3 5 2-1v10h8V11l2 1 3-5-5-4c0 4-8 4-8 0Z',workshop:'m14 4 6 6-10 10H4v-6Z M11 7l6 6',world:'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2Z M9 3v16 M15 5v16',games:'M7 7h10c3 0 4 3 4 7s-2 5-5 1H8c-3 4-5 3-5-1s1-7 4-7Z M7 10v4 M5 12h4 M16 11h.01 M18 13h.01',orders:'M6 3h12v18H6Z M9 8h6 M9 12h6 M9 16h3',cart:'M3 4h2l2 12h11l3-9H6 M8 20h.01 M17 20h.01',settings:'M9 3h6l1 4 4 1v7l-4 1-1 5H9l-1-5-4-1V8l4-1Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',arrow:'M5 12h14 M13 6l6 6-6 6',heart:'M12 20 4 12C-2 5 7 0 12 7 17 0 26 5 20 12Z',spark:'m12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2Z',bear:'M6 8C1 7 2 1 6 3l2 3c3-2 5-2 8 0l2-3c4-2 5 4 0 5 6 12-18 12-12 0Z M8 12h.01 M16 12h.01 M10 15q2 2 4 0'};
  const icon=name=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('class','st-icon');s.setAttribute('aria-hidden','true');const p=document.createElementNS(s.namespaceURI,'path');p.setAttribute('d',paths[name]||paths.spark);s.append(p);return s};
  const button=(text,fn,cls='cx-primary',ico)=>e('button',{type:'button',class:cls,onclick:fn},[ico?icon(ico):null,text]);
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  let prefs={theme:'game',motion:!reducedMotion.matches,bear3d:false,largeTargets:false,hand:'right'};try{Object.assign(prefs,JSON.parse(localStorage.getItem('bearlab.studio.prefs')||'{}'))}catch(_){}
  const save=()=>{try{localStorage.setItem('bearlab.studio.prefs',JSON.stringify(prefs))}catch(_){}document.body.dataset.theme=prefs.theme==='game'?'game':'studio';document.body.dataset.motion=prefs.motion&&!reducedMotion.matches?'on':'off';document.body.dataset.targets=prefs.largeTargets?'large':'normal';document.body.dataset.hand=prefs.hand==='left'?'left':'right'};
  const theme=v=>{prefs.theme=v;save();api.set3d(prefs.bear3d);shell();api.render();};
  const money=n=>new Intl.NumberFormat('ru-RU').format(n)+' ₽';
  const outfitName=c=>api.catalog.find(x=>(c.clothes||[]).includes(x.id)&&x.slot==='top')?.label||'Базовый образ';
  let snapshotTimer, snapshotTries=0;
  function art(c,thumb=false,card=false,stored){
    const illustrated=!stored&&!api.needsSnapshot({...c,clothes:[],acc:[]})&&(c.clothes||[]).every(id=>api.catalog.some(x=>x.id===id));
    const snapshot=stored||(!illustrated&&api.snapshot(c));
    if(snapshot){clearTimeout(snapshotTimer);snapshotTimer=null;snapshotTries=0;return e('img',{src:snapshot,class:'st-bear-art cx-flat st-render'+(thumb?' st-thumb':''),alt:(c.name||'Мишка')+' — снимок комплектации','data-clothes':(c.clothes||[]).join(' ')})}
    if(!illustrated&&api.needsSnapshot(c)&&!snapshot){
      if(!card&&api.currentSnapshot(c)&&api.modelReady()&&snapshotTries<40){clearTimeout(snapshotTimer);snapshotTimer=setTimeout(()=>{snapshotTries++;if(document.body.dataset.screen!=='workshop')api.render()},200)}
    }
    const clothes=c.clothes||[],row=clothes.includes('hoodie')?1:clothes.includes('sundress')?2:0,col=clothes.includes('boots')?2:clothes.includes('sneakers')?1:0;
    const n=e('span',{class:'st-bear-art cx-flat st-2d-fallback'+(api.is3d()&&api.modelReady()?' st-hide-if-3d':'')+(thumb?' st-thumb':'')+(card?' st-card-art':''),role:'img','aria-label':(c.name||'Мишка')+' — '+outfitName(c)+(col===0?', без обуви':col===1?', кеды':', ботинки'),'data-clothes':clothes.join(' '),style:`--bear-x:${col*50}%;--bear-y:${row*50}%;background-position:var(--bear-x) var(--bear-y)`});
    const indices={tshirt:2,'hoodie-red':0,'sundress-pink':1,glasses:5,patch:6,crown:7,pirate:8,cap:9,helmet:10,headphones:11,chain:12,bowtie:13,scarf:14,cape:15,watch:16,plaster:17,guitar:18};
    if((c.acc||[]).some(id=>['cap','pirate','helmet'].includes(id)))n.classList.add('st-headroom');
    for(const id of [...clothes.filter(x=>['tshirt','hoodie-red','sundress-pink'].includes(x)),...(c.acc||[])]){const i=indices[id];if(i==null)continue;n.append(e('span',{class:'st-costume-layer st-costume-'+id,'aria-hidden':'true',style:`--sx:${i%5*25}%;--sy:${Math.floor(i/5)*100/3}%`}))}
    if(c.acc?.length)n.setAttribute('aria-label',n.getAttribute('aria-label')+', '+api.accessories.filter(x=>c.acc.includes(x.id)).map(x=>x.label).join(', '));
    return n;
  }
  function segment(options,current,onPick){return e('div',{class:'st-segment'},options.map(([id,label])=>e('button',{type:'button','aria-pressed':String(current===id),onclick:()=>onPick(id)},label)))}
  const navItems=[['home','Дом'],['workshop','Мастерская'],['wardrobe','Гардероб'],['world','Мир'],['games','Мини-игра']];
  function go(id){api.closeAdmin();if(id==='workshop')api.workshop();else if(['home','wardrobe','world','games','arcade'].includes(id))api.hub(id);else api.flow(id);sync();if(id==='arcade')game.openArcadeLobby()}
  let shellNode;
  function shell(){
    if(!shellNode){shellNode=e('div',{id:'studio-shell'});document.body.append(shellNode)}
    shellNode.replaceChildren(e('header',{class:'st-header'},[
      e('button',{type:'button',class:'st-logo',onclick:()=>go('home'),'aria-label':'BearLab — домой'},[e('span',{class:'st-mark'},icon('bear')),'bearlab',e('em',{},'/ studio')]),
      e('span',{class:'st-header-tag'},'Мастерская своего мишки'),
      e('div',{class:'st-header-right'},[e('span',{class:'st-saved'},[e('i'),'На этом устройстве']),segment([['studio','Студия'],['game','Игровой']],prefs.theme,theme)])
    ]),e('aside',{class:'st-side','aria-label':'Основное меню'},[
      e('p',{class:'st-nav-label'},'Пространство'),
      ...navItems.map(([id,label])=>e('button',{type:'button','data-route':id,onclick:()=>go(id)},[icon(id),label])),
      e('hr'),e('p',{class:'st-nav-label'},'Производство'),
      ...[['cart','Корзина'],['orders','Заявки']].map(([id,label])=>e('button',{type:'button','data-route':id,onclick:()=>go(id)},[icon(id),label])),
      e('div',{class:'st-side-bottom'},[e('strong',{},'Создаём. Примеряем. Обсуждаем.'),'Демозаявки хранятся локально. Для передачи коллеге скачайте JSON.'])
    ]));sync();
  }
  let bearObserver;
  function sync(){game.sync();const id=document.body.dataset.screen;document.querySelectorAll('.cx-gem').forEach(b=>b.dataset.gem=b.getAttribute('aria-label'));if(id==='games'&&!document.querySelector('.st-game-help')){const play=document.querySelector('.cx-play');play?.prepend(e('p',{class:'st-game-help'},'Выберите две соседние фишки. Соберите линию из трёх или больше.'))}const host=api.is3d()&&id!=='workshop'?document.querySelector('#concept .cx-hero'):null;api.mountBear(host);if(bearObserver)bearObserver.disconnect();if(host&&window.ResizeObserver){bearObserver=new ResizeObserver(()=>api.resizeBear());bearObserver.observe(host)}document.querySelectorAll('.st-side [data-route]').forEach(b=>{if(b.dataset.route===id)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});document.querySelectorAll('.cx-nav button').forEach((b,i)=>{const span=b.querySelector('span');if(span&&!span.querySelector('svg'))span.replaceChildren(icon(['home','wardrobe','world','games'][i]))});const gear=document.getElementById('cx-gear');if(gear&&!gear.querySelector('svg')){gear.replaceChildren(icon('settings'));gear.setAttribute('aria-label','Настройки прототипа');gear.title='Настройки прототипа'}document.querySelectorAll('.cx-iconbtn').forEach(b=>{if(!b.querySelector('svg')){[...b.childNodes].filter(n=>n.nodeType===3).forEach(n=>n.remove());b.prepend(icon('cart'))}})}
  function pageHeading(title,description,eyebrow){return e('div',{class:'st-page-heading'},e('div',{},[eyebrow?e('div',{class:'st-eyebrow'},eyebrow):null,e('h1',{},title),e('p',{},description)]))}
  function preview(){const c=api.config();return e('section',{class:'st-preview','aria-label':'Ваш мишка'},[
    e('div',{class:'st-preview-top'},[e('b',{},'Ваш персонаж'),e('span',{class:'st-mode'},api.is3d()?'3D-модель':api.needsSnapshot(c)?'Снимок модели':'2D-иллюстрация')]),
    e('div',{class:'st-hero cx-hero'},art(c)),
    e('div',{class:'st-preview-bottom'},[e('strong',{},c.name||'Мой мишка'),e('span',{},c.size+' см · '+outfitName(c))])
  ])}
  function home(){if(prefs.theme==='game')return game.home();const c=api.config();return e('div',{class:'cx-view','data-concept':'home'},[
    pageHeading('У каждого мишки — своя история.','Придумайте характер. Подберите образ. Заберите с собой.','BearLab · ваше пространство'),
    e('div',{class:'st-workspace'},[
      preview(),e('div',{class:'st-panel'},[
        e('section',{class:'st-panel-card st-home-info'},[e('div',{class:'st-eyebrow'},'Знакомьтесь'),e('h2',{},c.name||'Ваш новый друг'),e('p',{},'Мягкий характер и большой мир впереди. Начните с образа, который нравится именно вам.'),e('div',{class:'st-info-grid'},[e('div',{},[e('span',{},'Размер'),e('b',{},c.size+' см')]),e('div',{},[e('span',{},'Образ'),e('b',{},outfitName(c))])]),button('Подобрать образ',()=>go('wardrobe'),'cx-primary','arrow')]),
        e('section',{class:'st-panel-card'},[e('h2',{},'Маленький момент заботы'),e('p',{},'Угостите мишку — он будет рад вашему вниманию.'),e('div',{class:'st-panel-actions'},[button('Угостить',api.treat,'cx-primary','heart'),button('Изменить мишку',()=>go('workshop'),'cx-secondary','workshop')]),e('p',{class:'st-mini-note'},'В мастерской можно изменить цвет, детали и размер. Всё сохраняется на этом устройстве.')])
      ])
    ]),api.bottom('home')
  ])}
  function wardrobe(){if(prefs.theme==='game')return game.wardrobe();const c=api.config();const choose=o=>{api.setClothes(o);api.render()};return e('div',{class:'cx-view','data-concept':'wardrobe'},[
    pageHeading('Образ под настроение.','Один мишка. Столько способов быть собой.','Коллекция · 01'),
    e('div',{class:'st-workspace'},[
      preview(),e('div',{class:'st-panel'},[
        e('section',{class:'st-panel-card'},[
          e('h2',{},'Гардероб'),e('p',{},'Выберите готовый комплект или сочетайте вещи.'),
          e('div',{class:'st-outfits',role:'group','aria-label':'Образы'},api.outfits.map(o=>e('button',{type:'button',class:'st-outfit','aria-pressed':String(c.clothes.length===o.clothes.length&&c.clothes.every(x=>o.clothes.includes(x))),onclick:()=>choose(o.clothes.slice())},[art({...c,clothes:o.clothes},false,true),e('strong',{},o.name),e('small',{},o.clothes.length?'+'+money(api.clothesPrice(o.clothes)):'Без одежды')]))),
          e('div',{class:'st-items',role:'group','aria-label':'Отдельные вещи'},api.catalog.map(it=>e('button',{type:'button',class:'st-item','aria-pressed':String(c.clothes.includes(it.id)),onclick:()=>{let ids=c.clothes.slice();if(ids.includes(it.id))ids=ids.filter(x=>x!==it.id);else ids=ids.filter(x=>api.catalog.find(y=>y.id===x)?.slot!==it.slot).concat(it.id);choose(ids)}},it.label))),
          e('div',{class:'st-panel-price'},['Мишка с выбранным комплектом',e('b',{},money(api.price()))]),
          e('p',{class:'st-caption'},'Демонстрационная цена. Без оплаты.')
        ]),
        e('div',{class:'st-panel-actions'},[button('Посмотреть образ',()=>go('look'),'cx-primary','arrow')])
      ])
    ]),api.bottom('wardrobe')
  ])}
  function world(){
    if(prefs.theme==='game')return game.world();
    const places=[['workshop','Мастерская','Цвет, форма и характер'],['wardrobe','Гардероб','Найдите любимый образ'],['games','Мини-игра','Соберите три в ряд']];
    return e('div',{class:'cx-view','data-concept':'world'},[
      pageHeading('Маленький мир. Большие истории.','Выберите, куда отправимся вместе с мишкой.','BearLab · карта мира'),
      e('div',{class:'st-world-scroll'},[
        e('div',{class:'st-world-scene'},[
          e('img',{src:'assets/demo/world.png',alt:'Уютная площадь: мастерская с зелёной крышей, сиреневый гардероб и жёлтый игровой павильон',width:1536,height:1024}),
          ...places.map(([id,label])=>button(label,()=>go(id),'st-world-pin st-pin-'+id,id))
        ]),
        e('div',{class:'st-destinations'},places.map(([id,label,desc])=>e('button',{type:'button',onclick:()=>go(id)},[e('span',{class:'st-destination-icon'},icon(id)),e('span',{},[e('strong',{},label),e('small',{},desc)]),icon('arrow')]))),
        e('p',{class:'st-caption'},'Иллюстрация — проба, не утверждено.')
      ]),api.bottom('world')
    ])
  }
  let lastFocus=null;
  function admin(){
    const box=document.getElementById('cx-admin');if(box.hidden)lastFocus=document.activeElement;
    const close=()=>{api.closeAdmin();lastFocus?.focus()};
    const setting=(title,desc,control)=>e('div',{class:'st-setting'},[e('div',{},[e('b',{},title),e('small',{},desc)]),control]);
    const select=(label,options,current,onChange)=>{const s=e('select',{'aria-label':label},options.map(([id,text])=>e('option',{value:id},text)));s.value=current;s.onchange=()=>onChange(s.value);return s};
    const name=e('input',{type:'text','aria-label':'Имя мишки',maxlength:10,value:api.config().name||'',placeholder:'Например, Тоша'});name.addEventListener('change',()=>{api.setName(name.value.trim());api.render()});
    const size=select('Размер мишки',[['20','20 см'],['30','30 см'],['45','45 см']],api.config().size,v=>{api.setSize(v);api.render()});
    const scenes=[['home','Дом'],['workshop','Мастерская'],['wardrobe','Гардероб'],['look','Мой мишка'],['cart','Корзина'],['delivery','Доставка'],['confirm','Подтверждение'],['orders','Заявки'],['assembly','Лист сборки'],['share','Поделиться'],['world','Мир'],['arcade','Три мини-игры'],['games','Три в ряд'],['result','Результат']];
    const jump=id=>{const s=api.orders();if(id==='delivery'&&!s.cart.length){api.toast('Сначала добавьте мишку в корзину');return}if(['confirm','assembly'].includes(id)){if(!s.orders.length){api.toast('Сначала соберите демозаявку');return}close();api.flow(id,{orderId:s.orders[0].id});return}close();go(id)};
    const content=e('div',{class:'cx-sheet',role:'dialog','aria-modal':'true','aria-label':'Настройки прототипа'},[
      e('div',{class:'st-dialog-head'},[e('div',{},[e('h3',{},'Настройки прототипа'),e('p',{},'Одни данные. Два способа посмотреть на игру.')]),e('button',{type:'button',class:'st-dialog-close','aria-label':'Закрыть настройки',onclick:close},'×')]),
      setting('Интерфейс','Спокойная студия или игровой характер.',segment([['studio','Студия'],['game','Игровой']],prefs.theme,v=>{theme(v);admin()})),
      setting('Персонаж','Иллюстрация для показа или техническая 3D-модель.',segment([['2d','2D'],['3d','3D']],api.is3d()?'3d':'2d',v=>{prefs.bear3d=v==='3d';save();api.set3d(prefs.bear3d);api.render();admin()})),
      setting('Анимации',reducedMotion.matches?'Движение уменьшено настройкой вашего устройства.':'Мягкие переходы и реакция мишки.',segment([['on','Вкл'],['off','Выкл']],prefs.motion?'on':'off',v=>{prefs.motion=v==='on';save();admin()})),
      setting('Крупнее кнопки','Больше места для нажатия и меньше вещей в одном ряду.',segment([['normal','Обычно'],['large','Крупнее']],prefs.largeTargets?'large':'normal',v=>{prefs.largeTargets=v==='large';save();admin()})),
      setting('Ведущая рука','В горизонтальной игре действия располагаются ближе к выбранной руке.',segment([['left','Левая'],['right','Правая']],prefs.hand,v=>{prefs.hand=v;save();admin()})),
      setting('Имя мишки','Отображается в вашем заказе.',name),setting('Размер','Демонстрационная комплектация.',size),
      game.demoControls(),
      e('p',{class:'st-dialog-section'},'Карта экранов'),e('div',{class:'st-screen-map'},scenes.map(([id,label])=>button(label,()=>jump(id),'',null))),
      e('p',{class:'st-disclosure'},'Демозаявки сохраняются только в этом браузере. Для обмена — JSON. Иллюстрации созданы ИИ: проба, не утверждено. Изготовимость и цены требуют согласования с производством.')
    ]);
    box.replaceChildren(content);box.hidden=false;
    content.addEventListener('keydown',ev=>{if(ev.key==='Tab'){const list=[...content.querySelectorAll('button,input,select,textarea')].filter(n=>!n.disabled);const first=list[0],last=list[list.length-1];if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus()}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus()}}});
    if(!content.contains(document.activeElement))content.querySelector('button')?.focus();
  }
  const game=window.BearLabGame.install({...api,e,art,go,icon,preferences:()=>({...prefs,motion:prefs.motion&&!reducedMotion.matches,motionLocked:reducedMotion.matches}),comfort:update=>{Object.assign(prefs,update);save()}});
  reducedMotion.addEventListener('change',save);
  save();api.set3d(prefs.bear3d);shell();
  return {confirmRestart:game.confirmRestart,arcade:game.arcade,recordMatch3:game.recordMatch3,canStart:game.canStart,gem:i=>prefs.theme==='game'?game.gem(i):null,reward:game.reward,bottom:id=>prefs.theme==='game'?game.nav(id==='wardrobe'?'collection':id):null,bear:(c,s,t,p)=>{if(!p&&(s||[]).some(it=>{const current=api.catalog.find(x=>x.id===it.id);return !current||current.color!==it.color}))return e('span',{class:'st-preview-pending st-thumb',role:'img','aria-label':'Историческая комплектация — исходные параметры сохранены'},[icon('bear'),'Состав сохранён']);return art(c||api.config(),!!t,false,p)},home,wardrobe,world,admin,sync,icon};
}};
