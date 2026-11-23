'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const M=require('../sandbox/life-model.js');
const initial=overrides=>M.normalize({...M.normalize(null),...overrides});
const apply=(state,type,fields={})=>M.transact(state,{type,...fields});
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value};

test('migrates pet.v1 without losing balances or flags and without inventing earned stars',()=>{
  const old={coins:321,stars:320,food:64,mood:90,energy:18,xp:765,gift:true,claimed:true,fed:true,styled:true,explored:true};
  const s=M.normalize(old);
  for(const [key,value] of Object.entries(old))assert.equal(s[key],value,key);
  assert.equal(s.earnedStars,0);assert.equal(s.thirst,78);assert.equal(s.hygiene,82);
  assert.deepEqual(s.inventory,{water:2,apple:2,burger:0,soap:1});
  assert.deepEqual(s.startedRuns,[]);assert.deepEqual(s.rewardedRuns,[]);
  assert.equal(apply(s,'capsule',{random01:0}).ok,false);
  assert.deepEqual(M.normalize(s),s);
});

test('normalization bounds needs, validates stored fields and never refills existing empty inventory',()=>{
  const s=M.normalize({coins:-3,stars:20,earnedStars:80,energy:500,food:NaN,mood:-1,thirst:Infinity,hygiene:45.8,gift:'true',inventory:{water:-1,apple:500,soap:'2'},ownedRewards:['bad','mint-morning','mint-morning'],startedRuns:['run-1',null,'','<html>','run-1'],activeSeconds:NaN});
  assert.equal(s.coins,0);assert.equal(s.earnedStars,20);assert.equal(s.energy,100);assert.equal(s.food,72);assert.equal(s.mood,0);assert.equal(s.thirst,78);assert.equal(s.hygiene,45);assert.equal(s.gift,false);
  assert.deepEqual(s.inventory,{water:0,apple:99,burger:0,soap:0});assert.deepEqual(s.ownedRewards,['mint-morning']);assert.deepEqual(s.startedRuns,['run-1']);
  assert.equal(M.normalize({inventory:{}}).inventory.apple,0);
});

test('buy and use are one atomic state change with accurate capped effects',()=>{
  const s=freeze(initial({coins:15,food:90,inventory:{water:0,apple:0,burger:0,soap:0}}));
  const buy=apply(s,'buy',{itemId:'apple'});assert.equal(buy.ok,true);assert.equal(buy.state.coins,0);assert.equal(buy.state.inventory.apple,1);assert.equal(s.inventory.apple,0);
  const use=apply(freeze(buy.state),'use',{itemId:'apple'});assert.equal(use.state.food,100);assert.equal(use.state.inventory.apple,0);assert.equal(use.state.fed,true);assert.match(use.message,/\+10/);
  const denied=apply(use.state,'buy',{itemId:'apple'});assert.equal(denied.ok,false);assert.deepEqual(denied.state,use.state);
});

test('full needs, absent stock, unknown items and full bags never consume resources',()=>{
  const s=initial({food:100,thirst:100,hygiene:100,inventory:{water:1,apple:1,burger:0,soap:1}});
  for(const itemId of ['water','apple','soap','burger','unknown','__proto__']){
    const out=apply(s,'use',{itemId});assert.equal(out.ok,false,itemId);assert.deepEqual(out.state,s);
  }
  const full=initial({inventory:{water:99,apple:0,burger:0,soap:0}});
  assert.deepEqual(apply(full,'buy',{itemId:'water'}).state,full);
  assert.equal(apply(s,'buy',{itemId:'invalid'}).ok,false);
});

test('water, food and soap change only their specified needs; burger increases mood',()=>{
  for(const [itemId,key,gain]of [['water','thirst',30],['apple','food',25],['burger','food',45],['soap','hygiene',40]]){
    const s=initial({food:10,thirst:10,hygiene:10,mood:10,inventory:{water:1,apple:1,burger:1,soap:1}});
    const out=apply(s,'use',{itemId});assert.equal(out.ok,true);assert.equal(out.state[key],10+gain);assert.equal(out.state.inventory[itemId],0);assert.equal(out.state.coins,s.coins);assert.equal(out.state.mood,itemId==='burger'?15:10);
  }
});

test('basic snack and water are free emergency care, limited by need rather than a refill exploit',()=>{
  let s=initial({coins:0,food:0,thirst:9,inventory:{}});
  s=apply(s,'use',{itemId:'basic-snack'}).state;assert.equal(s.food,50);assert.equal(s.fed,true);
  s=apply(s,'use',{itemId:'basic-water'}).state;assert.equal(s.thirst,50);assert.equal(s.coins,0);
  for(const itemId of ['basic-snack','basic-water']){const out=apply(s,'use',{itemId});assert.equal(out.ok,false);assert.deepEqual(out.state,s)}
});

test('free rest removes energy dead ends and reports the real capped gain',()=>{
  const zero=initial({coins:0,stars:0,energy:0});assert.equal(apply(zero,'startGame',{runId:'first'}).ok,false);
  const rest=apply(zero,'rest');assert.equal(rest.state.energy,30);assert.equal(rest.state.coins,0);
  assert.equal(apply(rest.state,'startGame',{runId:'first'}).state.energy,20);
  const almost=apply(initial({energy:95}),'rest');assert.equal(almost.state.energy,100);assert.match(almost.message,/\+5/);
  assert.doesNotMatch(apply(initial({energy:100}),'rest').message,/\+30/);
});

test('walk and play have concrete effects and fail safely when energy is low',()=>{
  const s=initial({energy:15,mood:60,thirst:50,hygiene:50});
  const walk=apply(s,'walk');assert.equal(walk.state.energy,10);assert.equal(walk.state.mood,72);assert.equal(walk.state.explored,true);assert.equal(walk.state.thirst,45);assert.equal(walk.state.hygiene,47);
  const play=apply(s,'play');assert.equal(play.state.energy,10);assert.equal(play.state.mood,75);assert.equal(play.state.explored,false);
  const tired=initial({energy:4});assert.deepEqual(apply(tired,'walk').state,tired);assert.equal(apply(tired,'play').ok,false);
});

test('tick consumes active time only, accumulates short deltas and clamps suspended-tab gaps',()=>{
  const s=initial();assert.deepEqual(apply(s,'tick',{active:false,seconds:86400}).state,s);
  const a=apply(s,'tick',{active:true,seconds:30}).state;assert.equal(a.food,s.food);assert.equal(a.activeSeconds,30);
  const b=apply(a,'tick',{active:true,seconds:30}).state;assert.equal(b.food,s.food-1);assert.equal(b.thirst,s.thirst-2);assert.equal(b.activeSeconds,0);
  const gap=apply(s,'tick',{active:true,seconds:8640000}).state;assert.equal(gap.food,s.food-1);assert.equal(gap.energy,s.energy-1);
  assert.equal(apply(s,'tick',{active:true,seconds:NaN}).ok,false);assert.equal(apply(s,'tick',{active:true,seconds:-1}).ok,false);
  const empty=initial({food:0,thirst:0,hygiene:0,energy:0,mood:0});assert.equal(M.health(apply(empty,'tick',{active:true,seconds:60}).state),0);assert.equal(apply(empty,'rest').state.energy,30);
});

test('all three games pay energy once per run, including resume and completed-run replay',()=>{
  let s=initial({energy:100});
  for(const [i,gameId]of M.GAME_IDS.entries()){
    const runId='run:'+i;s=apply(s,'startGame',{runId,gameId}).state;assert.equal(s.energy,90-i*10);
    const repeated=apply(s,'startGame',{runId,gameId});assert.equal(repeated.ok,true);assert.equal(repeated.state.energy,s.energy);
    s=apply(s,'reward',{runId,gameId,score:1000}).state;
    assert.equal(apply(s,'startGame',{runId,gameId}).state.energy,s.energy);
  }
  assert.equal(s.startedRuns.length,3);assert.equal(s.rewardedRuns.length,3);
  assert.equal(apply(s,'startGame',{runId:'invalid',gameId:'not-a-game'}).ok,false);
});

test('rewards require a started run and deduplicate across interleaved games and serialization',()=>{
  let s=initial({coins:0,stars:0,xp:0,earnedStars:0});
  assert.equal(apply(s,'reward',{gameId:'memory',runId:'never-started',score:1000}).ok,false);
  s=apply(s,'startGame',{runId:'memory:1'}).state;s=apply(s,'startGame',{runId:'trail:1'}).state;
  const first=apply(s,'reward',{gameId:'memory',runId:'memory:1',score:1000});assert.deepEqual(first.reward,{coins:100,stars:10,xp:30});assert.equal(first.state.earnedStars,10);
  const second=apply(first.state,'reward',{gameId:'trail',runId:'trail:1',score:800});s=M.normalize(JSON.parse(JSON.stringify(second.state)));
  const replay=apply(s,'reward',{gameId:'memory',runId:'memory:1',score:99999});assert.equal(replay.ok,true);assert.equal(replay.reward,undefined);assert.deepEqual(replay.state,s);
  assert.equal(apply(s,'reward',{gameId:'memory',runId:'memory:1',score:NaN}).ok,false);
});

test('run history is bounded and keeps enough completed rounds for deduplication',()=>{
  let s=initial();
  for(let i=0;i<M.RUN_LIMIT+25;i++){
    s=apply(s,'rest').state;s=apply(s,'startGame',{runId:'game-'+i}).state;s=apply(s,'reward',{gameId:'match3',runId:'game-'+i,score:100}).state;
  }
  assert.equal(s.startedRuns.length,M.RUN_LIMIT);assert.equal(s.rewardedRuns.length,M.RUN_LIMIT);
  for(let i=25;i<M.RUN_LIMIT+25;i+=19)assert.deepEqual(apply(s,'reward',{gameId:'match3',runId:'game-'+i,score:100}).state,s);
});

test('capsules spend earned stars only, select equal buckets and reject invalid randomness atomically',()=>{
  const s=initial({stars:500,earnedStars:50});
  for(let i=0;i<6;i++){
    const out=apply(s,'capsule',{random01:(i+.5)/6});assert.equal(out.ok,true);assert.equal(out.reward.id,M.REWARDS[i].id);assert.equal(out.state.stars,450);assert.equal(out.state.earnedStars,0);assert.equal(s.ownedRewards.length,0);
  }
  for(const random01 of [-1,1,Infinity,NaN,'0.5',undefined]){const out=apply(s,'capsule',{random01});assert.equal(out.ok,false);assert.deepEqual(out.state,s)}
  const insufficient=initial({stars:500,earnedStars:49});assert.deepEqual(apply(insufficient,'capsule',{random01:.5}).state,insufficient);
});

test('capsule collection has no duplicates and completion never charges again',()=>{
  let s=initial({stars:320,earnedStars:300});
  for(let i=0;i<6;i++){const out=apply(s,'capsule',{random01:0});assert.equal(out.ok,true);assert.equal(out.reward.id,M.REWARDS[i].id);s=out.state}
  assert.equal(s.stars,20);assert.equal(s.earnedStars,0);assert.equal(new Set(s.ownedRewards).size,6);
  const complete=apply(s,'capsule',{random01:.8});assert.equal(complete.ok,false);assert.deepEqual(complete.state,s);
  assert.deepEqual(M.normalize(JSON.parse(JSON.stringify(s))),s);
});

test('invalid actions are safe and transactions do not mutate frozen nested state',()=>{
  const s=freeze(initial());
  for(const action of [null,[],{}, {type:'unknown'}, {type:'startGame',runId:'<invalid>'}])assert.equal(M.transact(s,action).ok,false);
  assert.equal(apply(s,'buy',{itemId:'water'}).state.inventory.water,3);assert.equal(s.inventory.water,2);
  assert.equal(apply(s,'rest').state.energy,100);assert.equal(s.energy,80);
  assert.equal(M.health({food:100,thirst:100,hygiene:100,energy:100,mood:100}),100);
});
