/* Pure, local virtual-pet rules. No clock, storage, network or implicit random source. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BearLabLifeModel = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const MAX_BALANCE = 999999;
  const RUN_LIMIT = 256;
  const GAME_IDS = Object.freeze(['match3', 'memory', 'trail']);
  const NEEDS = Object.freeze(['food', 'thirst', 'hygiene', 'energy', 'mood']);
  const ITEMS = Object.freeze([
    Object.freeze({id:'water', name:'Родниковая вода', kind:'drink', price:10, icon:'water', effect:Object.freeze({thirst:30}), description:'Жажда +30'}),
    Object.freeze({id:'apple', name:'Сочное яблоко', kind:'food', price:15, icon:'apple', effect:Object.freeze({food:25}), description:'Сытость +25'}),
    Object.freeze({id:'burger', name:'Домашний бургер', kind:'food', price:35, icon:'burger', effect:Object.freeze({food:45,mood:5}), description:'Сытость +45 · настроение +5'}),
    Object.freeze({id:'soap', name:'Пенное мыло', kind:'care', price:20, icon:'soap', effect:Object.freeze({hygiene:40}), description:'Чистота +40'})
  ]);
  const REWARDS = Object.freeze([
    Object.freeze({id:'mint-morning', name:'Мятное утро', colors:Object.freeze(['#68c8b4','#eaf7d9','#f7d86a']), config:Object.freeze({main:'#68c8b4',accent:'#eaf7d9',earColor:'#f7d86a'}), description:'Мятный мех и сливочные детали'}),
    Object.freeze({id:'berry-cloud', name:'Ягодное облако', colors:Object.freeze(['#bd80bd','#f7d4e8','#7376bf']), config:Object.freeze({main:'#bd80bd',accent:'#f7d4e8',earColor:'#7376bf'}), description:'Ягодный мех и нежный румянец'}),
    Object.freeze({id:'honey-sun', name:'Медовое солнце', colors:Object.freeze(['#e6b45c','#ffebba','#c97d4f']), config:Object.freeze({main:'#e6b45c',accent:'#ffebba',earColor:'#c97d4f'}), description:'Медовый мех и тёплые ушки'}),
    Object.freeze({id:'moon-lagoon', name:'Лунная лагуна', colors:Object.freeze(['#719ac9','#dcecf1','#8c80bb']), config:Object.freeze({main:'#719ac9',accent:'#dcecf1',earColor:'#8c80bb'}), description:'Голубой мех и лавандовые детали'}),
    Object.freeze({id:'peach-postcard', name:'Персиковая открытка', colors:Object.freeze(['#e6a28d','#ffe1c4','#b684aa']), config:Object.freeze({main:'#e6a28d',accent:'#ffe1c4',earColor:'#b684aa'}), description:'Персиковый мех и кремовая мордочка'}),
    Object.freeze({id:'forest-story', name:'Лесная история', colors:Object.freeze(['#9eae76','#eee5bc','#b58663']), config:Object.freeze({main:'#9eae76',accent:'#eee5bc',earColor:'#b58663'}), description:'Шалфейный мех и ореховые детали'})
  ]);
  const DEFAULTS = Object.freeze({coins:4250,stars:320,earnedStars:0,food:72,thirst:78,hygiene:82,mood:86,energy:80,xp:240,gift:false,claimed:false,fed:false,styled:false,explored:false});
  const STARTER_ITEMS = Object.freeze({water:2,apple:2,burger:0,soap:1});
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const num = (value, fallback, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
  const validRunId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id);
  const ids = (value, valid, limit) => Array.isArray(value) ? [...new Set(value.filter(valid))].slice(-limit) : [];
  function normalize(old) {
    old = record(old) ? old : {};
    const state = {lifeVersion:1};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      state[key] = typeof fallback === 'boolean' ? (typeof old[key] === 'boolean' ? old[key] : fallback) : num(old[key],fallback,NEEDS.includes(key)?100:MAX_BALANCE);
    }
    state.earnedStars = Math.min(state.stars, state.earnedStars);
    state.inventory = {};
    const firstMigration = !Object.prototype.hasOwnProperty.call(old, 'inventory');
    for (const item of ITEMS) state.inventory[item.id] = firstMigration ? STARTER_ITEMS[item.id] : num(record(old.inventory)?old.inventory[item.id]:undefined,0,99);
    state.ownedRewards = ids(old.ownedRewards,id=>REWARDS.some(r=>r.id===id),REWARDS.length);
    state.rewardedRuns = ids(old.rewardedRuns,validRunId,RUN_LIMIT);
    state.startedRuns = ids(old.startedRuns,validRunId,RUN_LIMIT);
    state.activeSeconds = num(old.activeSeconds,0,59);
    return state;
  }
  const appendRun = (runs,id) => runs.includes(id) ? runs : [...runs,id].slice(-RUN_LIMIT);
  function health(input) {
    const state = normalize(input);
    return Math.round(NEEDS.reduce((sum,key)=>sum+state[key],0)/NEEDS.length);
  }
  function transact(input, action) {
    const state = normalize(input);
    const result = (ok,message,reward) => ({state,ok,message,...(reward?{reward}:{})});
    if (!record(action)) return result(false,'Неизвестное действие.');
    const improve = changes => {
      const actual = {};
      for (const [key,amount] of Object.entries(changes)) {
        const before=state[key];state[key]=Math.max(0,Math.min(100,before+amount));actual[key]=state[key]-before;
      }
      return actual;
    };
    const credit = (key,amount) => {const before=state[key];state[key]=Math.min(MAX_BALANCE,before+amount);return state[key]-before};
    if (action.type === 'buy') {
      const item=ITEMS.find(item=>item.id===action.itemId);
      if (!item) return result(false,'Такого предмета нет в лавке.');
      if (state.inventory[item.id]>=99) return result(false,'В рюкзаке уже 99 таких предметов.');
      if (state.coins<item.price) return result(false,'Не хватает монет. Их можно заработать в мини-играх.');
      state.coins-=item.price;state.inventory[item.id]++;
      return result(true,item.name+' теперь в рюкзаке.');
    }
    if (action.type === 'use') {
      if (action.itemId==='basic-water'||action.itemId==='basic-snack') {
        const key=action.itemId==='basic-water'?'thirst':'food';
        if (state[key]>=50) return result(false,key==='thirst'?'Мишка уже напился. Бесплатная вода доступна, когда показатель ниже 50.':'Мишка пока не голоден. Перекус доступен при сытости ниже 50.');
        const delta=50-state[key];state[key]=50;
        if (key==='food') state.fed=true;
        return result(true,(key==='thirst'?'Попили воды! Жажда':'Перекусили! Сытость')+' +'+delta+'.');
      }
      const item=ITEMS.find(item=>item.id===action.itemId);
      if (!item) return result(false,'Такого предмета нет.');
      if (state.inventory[item.id]<1) return result(false,'Предмет закончился. Загляните в лавку.');
      const mainNeed=item.kind==='food'?'food':item.kind==='drink'?'thirst':'hygiene';
      if (state[mainNeed]>=100) return result(false,item.kind==='food'?'Мишка уже сыт. Угощение останется в рюкзаке.':item.kind==='drink'?'Мишка уже напился. Вода останется в рюкзаке.':'Мишка уже чистый. Мыло останется в рюкзаке.');
      state.inventory[item.id]--;
      const gain=improve(item.effect);
      if(item.kind==='food')state.fed=true;
      const labels={food:'сытость',thirst:'вода',hygiene:'чистота',mood:'настроение'};
      return result(true,item.name+': '+Object.entries(gain).filter(([,n])=>n>0).map(([k,n])=>labels[k]+' +'+n).join(', ')+'.');
    }
    if (action.type==='rest') {
      const gain=improve({energy:30,mood:3});
      return result(true,gain.energy?'Хорошо отдохнули! Энергия +'+gain.energy+'.':'Мишка уже отдохнул и рад побыть рядом.');
    }
    if (action.type==='walk'||action.type==='play') {
      if(state.energy<5)return result(false,'Сначала немного отдохнём — отдых всегда бесплатный.');
      const walk=action.type==='walk';
      const gain=improve({energy:-5,mood:walk?12:15,thirst:walk?-5:-2,hygiene:walk?-3:0});
      if(walk)state.explored=true;
      return result(true,(walk?'Прогулялись по городку!':'Поиграли вместе!')+(gain.mood?' Настроение +'+gain.mood+'.':' Мишка доволен.'));
    }
    if (action.type==='tick') {
      if(action.active!==true)return result(true,'Пока вы не играете, потребности не меняются.');
      if(typeof action.seconds!=='number'||!Number.isFinite(action.seconds)||action.seconds<0)return result(false,'Неверное активное время.');
      // A caller must supply visible, active deltas. A suspended tab can never catch up hours.
      const elapsed=state.activeSeconds+Math.min(60,Math.floor(action.seconds));
      const minutes=Math.floor(elapsed/60);state.activeSeconds=elapsed%60;
      if(minutes)improve({food:-minutes,thirst:-2*minutes,hygiene:-minutes,energy:-minutes,mood:-minutes});
      return result(true,'');
    }
    if (action.type==='startGame') {
      if(!validRunId(action.runId)||action.gameId!=null&&!GAME_IDS.includes(action.gameId))return result(false,'Не удалось открыть этот раунд.');
      if(state.startedRuns.includes(action.runId)||state.rewardedRuns.includes(action.runId))return result(true,'Продолжаем раунд без повторной траты энергии.');
      if(state.energy<10)return result(false,'Для нового раунда нужно 10 энергии. Отдохните бесплатно.');
      state.energy-=10;state.startedRuns=appendRun(state.startedRuns,action.runId);
      return result(true,'Новый раунд: −10 энергии.');
    }
    if (action.type==='reward') {
      if(!GAME_IDS.includes(action.gameId)||!validRunId(action.runId)||!Number.isFinite(action.score)||action.score<0)return result(false,'Результат раунда не распознан.');
      if(state.rewardedRuns.includes(action.runId))return result(true,'Награда за этот раунд уже получена.');
      if(!state.startedRuns.includes(action.runId))return result(false,'Сначала начните этот раунд.');
      const score=Math.min(100000000,Math.floor(action.score));
      const reward={coins:credit('coins',Math.max(10,Math.min(200,Math.floor(score/10)))),stars:credit('stars',Math.max(5,Math.min(15,5+Math.floor(score/200)))),xp:credit('xp',30)};
      state.earnedStars=Math.min(state.stars,MAX_BALANCE,state.earnedStars+reward.stars);
      improve({mood:10});state.rewardedRuns=appendRun(state.rewardedRuns,action.runId);
      return result(true,'Раунд завершён! +'+reward.coins+' монет и +'+reward.stars+' звёзд.',reward);
    }
    if (action.type==='capsule') {
      const pool=REWARDS.filter(item=>!state.ownedRewards.includes(item.id));
      if(!pool.length)return result(false,'Все шесть палитр уже собраны. Звёзды остались у вас.');
      if(typeof action.random01!=='number'||!Number.isFinite(action.random01)||action.random01<0||action.random01>=1)return result(false,'Не удалось выбрать палитру. Звёзды не потрачены.');
      if(state.earnedStars<50||state.stars<50)return result(false,'Нужно 50 заработанных звёзд. Получайте их за завершённые мини-игры.');
      const palette=pool[Math.floor(action.random01*pool.length)];
      state.stars-=50;state.earnedStars-=50;state.ownedRewards.push(palette.id);
      return result(true,'Ваша новая палитра — «'+palette.name+'»!',{id:palette.id,name:palette.name,colors:[...palette.colors],config:{...palette.config}});
    }
    return result(false,'Неизвестное действие.');
  }
  return Object.freeze({normalize,transact,health,ITEMS,REWARDS,GAME_IDS,NEEDS,RUN_LIMIT,CAPSULE_COST:50});
});
