/* Care surfaces share the existing game dialog and the parent's single state transaction. */
window.BearLabLife={install(api){
  'use strict';
  const M=window.BearLabLifeModel;
  if(!M)throw new Error('BearLabLifeModel must load before BearLabLife');
  const {e,gi,art}=api;
  const current=()=>M.normalize(api.getState());
  const text=(tag,value,cls='')=>e(tag,{class:cls},value);
  const note=value=>text('p',value,'lf-note');
  const fmt=n=>new Intl.NumberFormat('ru-RU').format(n);
  let busy=false;
  const btn=(label,fn,cls='lf-button',disabled=false)=>e('button',{type:'button',class:cls,'aria-label':label,disabled:disabled?'':null,onclick:ev=>fn(ev.currentTarget)},label);
  function itemIcon(id){const icons={water:'care-water.svg',apple:'care-apple.svg',burger:'care-burger.svg',soap:'care-soap.svg'};return e('img',{class:'lf-item-icon','aria-hidden':'true',alt:'',src:'assets/demo/'+(icons[id]||icons.water)})}
  function wallet(){const s=current();return e('div',{class:'lf-wallet'},[e('span',{},[gi('coin'),text('b',fmt(s.coins)),text('small','монет')]),e('span',{},[gi('star'),text('b',fmt(s.earnedStars)),text('small','заработано')])])}
  function meter(label,value,key){return e('div',{class:'lf-meter lf-'+key},[text('span',label),text('b',value+' / 100'),e('div',{role:'progressbar','aria-label':label,'aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':value},e('i',{style:'width:'+value+'%'}))])}
  function show(title,children){api.open(title,children,'lf-sheet')}
  function navigate(id){api.close();api.go(id)}
  async function run(action,after,control){
    if(busy)return;busy=true;
    const label=control?.getAttribute('aria-label');if(control)control.disabled=true;
    try{
      const result=await api.dispatch(action);
      if(!result||typeof result.ok!=='boolean')throw new Error('Не удалось сохранить действие.');
      if(result.ok){api.render?.();after?.(result)}
      if(result.message)api.toast(result.message);
      if(label)[...document.querySelectorAll('.lf-sheet button')].find(n=>n.getAttribute('aria-label')===label&&!n.disabled)?.focus({preventScroll:true});
      return result;
    }catch(error){api.toast(error.message||'Не удалось сохранить действие.')}finally{busy=false;if(control?.isConnected)control.disabled=false}
  }
  function act(label,action,after,cls='lf-button',disabled=false){return btn(label,control=>run(action,after,control),cls,disabled)}
  function status(){const s=current(),h=M.health(s);show(api.config().name||'Мой мишка',[
    e('div',{class:'lf-status-hero'},[e('div',{class:'lf-pet'},art(api.config())),e('div',{class:'lf-health'},[gi('heart'),text('b',h+' / 100'),text('span','Самочувствие'),text('small',h>=75?'Мишке хорошо':h>=45?'Время немного позаботиться':'Мишка ждёт вашей заботы')])]),
    e('div',{class:'lf-needs'},[meter('Сытость',s.food,'food'),meter('Вода',s.thirst,'thirst'),meter('Чистота',s.hygiene,'hygiene'),meter('Энергия',s.energy,'energy'),meter('Настроение',s.mood,'mood')]),
    e('div',{class:'lf-care-actions'},[btn('Угостить и напоить',feed),btn('Отдохнуть · бесплатно',rest),btn('Прогуляться · 5 энергии',walk),act('Поиграть вместе · 5 энергии',{type:'play'},()=>{api.treat?.('play');status()}),s.inventory.soap?act('Помыть · 1 мыло',{type:'use',itemId:'soap'},status):btn('Выбрать мыло в лавке',market)]),
    note('Самочувствие зависит от пяти показателей. Пока игра закрыта, они не уменьшаются. Мишка всегда может бесплатно отдохнуть.')
  ])}
  function freeBasics(){const s=current();return e('section',{class:'lf-basics'},[
    text('h3','Забота всегда рядом'),text('p','Если показатель ниже 50, простая вода или перекус бесплатно поднимут его до 50.'),
    e('div',{class:'lf-basic-actions'},[act(s.thirst<50?'Простая вода · бесплатно':'Вода пока не нужна',{type:'use',itemId:'basic-water'},feed,'lf-quiet',s.thirst>=50),act(s.food<50?'Перекус · бесплатно':'Перекус пока не нужен',{type:'use',itemId:'basic-snack'},feed,'lf-quiet',s.food>=50)])
  ])}
  function useItem(item,after,control){run({type:'use',itemId:item.id},()=>{if(item.kind==='food')api.treat?.('food');after()},control)}
  function itemCard(item,mode){const s=current(),qty=s.inventory[item.id],buy=mode==='buy';const primaryNeed=item.kind==='food'?'food':item.kind==='drink'?'thirst':'hygiene';const disabled=buy?s.coins<item.price||qty>=99:qty<1||s[primaryNeed]>=100;return e('article',{class:'lf-product'},[
    e('div',{class:'lf-product-top'},[itemIcon(item.id),text('span',qty+' в рюкзаке','lf-quantity')]),text('h3',item.name),text('p',item.description),
    btn(buy?'Купить · '+item.price+' монет':qty===0?'Закончился':s[primaryNeed]>=100?'Пока не нужно':item.kind==='care'?'Помыть':item.kind==='drink'?'Напоить':'Угостить',control=>buy?run({type:'buy',itemId:item.id},market,control):useItem(item,mode==='inventory'?inventory:feed,control),'lf-button',disabled)
  ])}
  function feed(){const s=current();show('Время вкусненького',[
    e('div',{class:'lf-needs'},[meter('Сытость',s.food,'food'),meter('Вода',s.thirst,'thirst')]),
    e('div',{class:'lf-products'},M.ITEMS.filter(item=>item.kind!=='care').map(item=>itemCard(item,'feed'))),freeBasics(),btn('Пополнить запасы',market,'lf-quiet')
  ])}
  function market(){show('Лавка заботы',[
    wallet(),text('p','Выберите угощения и всё для ухода. Купленные предметы остаются в рюкзаке.','lf-lead'),
    e('div',{class:'lf-products'},M.ITEMS.map(item=>itemCard(item,'buy'))),btn('Открыть рюкзак',inventory,'lf-quiet'),
    note('Монеты зарабатываются в мини-играх. Покупок за реальные деньги нет. Для начала в рюкзаке уже есть вода, яблоки и мыло.')
  ])}
  function swatches(reward){return e('div',{class:'lf-swatches','aria-label':reward.name+' — цветовая палитра'},reward.colors.map(color=>e('i',{style:'background:'+color})))}
  function palette(reward){show(reward.name,[swatches(reward),text('p',reward.description,'lf-lead'),text('p','Палитра сохранена в вашей коллекции. Одежда и аксессуары из мастерской остаются доступны.','lf-note'),
    ...(typeof api.applyReward==='function'?[btn('Применить палитру',()=>{api.applyReward({...reward.config});api.close();api.render?.()})]:[btn('Открыть мастерскую',()=>navigate('workshop')),note('Цвета палитры можно выбрать в мастерской: '+reward.colors.join(' · '))]),btn('В коллекцию палитр',capsule,'lf-quiet')])}
  function rewardCard(reward,owned){return e('article',{class:'lf-palette'+(owned?' lf-owned':'')},[swatches(reward),text('h3',reward.name),text('small',owned?'В коллекции':'Ещё не получена'),...(owned?[btn('Посмотреть '+reward.name,()=>palette(reward),'lf-palette-open')]:[])])}
  function inventory(){const s=current(),owned=M.ITEMS.filter(item=>s.inventory[item.id]>0);show('Мой рюкзак',[
    wallet(),text('h3','Запасы заботы','lf-section-title'),owned.length?e('div',{class:'lf-products'},owned.map(item=>itemCard(item,'inventory'))):e('div',{class:'lf-empty'},[gi('backpack'),text('h3','В рюкзаке пока пусто'),text('p','Можно зайти в лавку или воспользоваться простой водой и перекусом.')]),
    e('div',{class:'lf-two-actions'},[btn('В лавку',market),btn('Бесплатная забота',feed,'lf-quiet')]),
    text('h3','Мои палитры · '+s.ownedRewards.length+' / '+M.REWARDS.length,'lf-section-title'),
    s.ownedRewards.length?e('div',{class:'lf-palettes'},M.REWARDS.filter(r=>s.ownedRewards.includes(r.id)).map(r=>rewardCard(r,true))):note('Завершайте мини-игры и открывайте палитры за заработанные звёзды.'),
    btn('Коллекция капсул',capsule,'lf-quiet'),e('div',{class:'lf-two-actions'},[btn('Мой образ',()=>navigate('wardrobe'),'lf-quiet'),btn('Мои демозаявки',()=>navigate('orders'),'lf-quiet')])
  ])}
  function capsule(){const s=current(),remaining=M.REWARDS.length-s.ownedRewards.length,ready=remaining>0&&s.earnedStars>=M.CAPSULE_COST;const chance=remaining?(100/remaining).toLocaleString('ru-RU',{maximumFractionDigits:1}):0;show('Капсула вдохновения',[
    e('div',{class:'lf-capsule-hero'},[gi('gift'),text('h3','Новая палитра для вашего мишки'),text('p','Шесть маленьких историй. Каждый раз — новая.')]),wallet(),
    btn(remaining?'Открыть · 50 заработанных звёзд':'Все палитры собраны',control=>run({type:'capsule',random01:Math.random()},result=>{if(result.reward)palette(M.REWARDS.find(r=>r.id===result.reward.id));else capsule()},control),'lf-button lf-open-capsule',!ready),
    text('p',remaining?'Сейчас '+remaining+' возможных палитр. Каждая выпадает с одинаковым шансом: 1 из '+remaining+' ('+chance+'%). Повторов нет.':'Все шесть палитр у вас. Звёзды больше не списываются.','lf-chance'),
    note('Только звёзды, заработанные за мини-игры. Их нельзя купить за реальные деньги. Начальный демонстрационный баланс сюда не входит.'),
    text('h3','Все возможные палитры','lf-section-title'),e('div',{class:'lf-palettes'},M.REWARDS.map(r=>rewardCard(r,s.ownedRewards.includes(r.id)))),btn('Выбрать мини-игру',()=>navigate('games'),'lf-quiet')
  ])}
  function rest(){return run({type:'rest'},status)}
  function walk(){return run({type:'walk'},()=>show('Хорошая прогулка',[
    gi('world','lf-walk-icon'),text('p','Свежий воздух и маленькие открытия. Мишка рад провести время вместе.','lf-lead'),
    meter('Настроение',current().mood,'mood'),meter('Энергия',current().energy,'energy'),btn('Исследовать городок',()=>navigate('world')),btn('Как чувствует себя мишка?',status,'lf-quiet')
  ]))}
  return {status,feed,market,inventory,capsule,rest,walk};
}};
