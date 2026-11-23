const test=require('node:test');
const assert=require('node:assert/strict');
const M=require('../sandbox/arcade-model.js');

test('memory: six pairs, incorrect pair stays readable; completion and reward record are unique',()=>{
  let run=M.createMemory('memory-1',()=>0.5);
  assert.deepEqual([...run.cards].sort(),[0,0,1,1,2,2,3,3,4,4,5,5]);
  const first=0,other=run.cards.findIndex(n=>n!==run.cards[first]);
  run=M.flip(run,first);run=M.flip(run,other);
  assert.equal(run.open.length,2);assert.equal(run.attempts,1);assert.equal(run.matched.length,0);
  assert.equal(M.flip(run,other),run);
  for(let value=0;value<6;value++){
    const pair=run.cards.map((v,i)=>v===value?i:-1).filter(i=>i>=0);
    // Explicitly clear the previously exposed wrong pair by selecting another card.
    if(run.open.length===2&&pair.some(i=>run.open.includes(i))){const spare=run.cards.findIndex((v,i)=>!run.open.includes(i)&&!run.matched.includes(i));run=M.flip(run,spare)}
    if(run.open.length===1&&!pair.includes(run.open[0])){run=M.flip(run,pair[0]);const spare=pair[1];run=M.flip(run,spare);run=M.flip(run,pair[0])}
    else {run=M.flip(run,pair[0]);run=M.flip(run,pair[1])}
  }
  assert.equal(run.complete,true);assert.equal(run.matched.length,12);
  assert.equal(M.flip(run,0),run);
  const result=M.finish(M.blank(),run,'Тедди',1000);
  assert.equal(result.added,true);
  assert.equal(M.finish(result.state,run,'Тедди',2000).added,false);
  assert.equal(result.state.records.length,1);
});

function routeSolution(map){
  const grid=M.cells(map),stars=grid.map((v,i)=>v==='*'?i:-1).filter(i=>i>=0);
  const start=grid.indexOf('S'),queue=[{p:start,mask:0,path:[]}],visited=new Set();
  for(let q=0;q<queue.length;q++){
    const {p,mask,path}=queue[q],key=p+':'+mask;if(visited.has(key))continue;visited.add(key);
    if(grid[p]==='H'&&mask===7)return path;
    for(const next of [p-5,p+5,p-1,p+1]){
      if(next<0||next>24||grid[next]==='#'||Math.abs(next%5-p%5)+Math.abs(Math.floor(next/5)-Math.floor(p/5))!==1)continue;
      const star=stars.indexOf(next);queue.push({p:next,mask:star>=0?mask|(1<<star):mask,path:[...path,next]});
    }
  }
  throw new Error('Unreachable route '+map);
}

for(let map=0;map<M.MAPS.length;map++)test(`trail ${map+1}: all three stars and home are reachable; reload preserves route`,()=>{
  let run=M.createTrail('trail-'+map,map),state=M.blank();
  assert.equal(M.move(run,24),run,'non-adjacent movement is rejected');
  const solution=routeSolution(map);
  for(const next of solution){run=M.move(run,next);state.runs.trail=run;state=M.restore(JSON.parse(JSON.stringify(state)));assert.deepEqual(state.runs.trail,run)}
  assert.equal(run.complete,true);assert.equal(run.collected.length,3);
  assert.equal(M.cells(map)[run.position],'H');
  assert.equal(M.move(run,run.position-1),run,'completed round is immutable');
  state=M.finish(state,run,'Тедди',1000).state;
  assert.equal(M.finish(state,run,'Тедди',2000).added,false);
});

test('save validator rejects corrupt game states and malicious score shapes',()=>{
  const memory=M.createMemory('m');const trail=M.createTrail('t');
  for(const broken of [{...memory,cards:Array(12).fill(1)},{...memory,matched:[0,0]},{...memory,complete:true},{...memory,attempts:-1},{...memory,open:[20]}])assert.equal(M.restore({version:1,runs:{memory:broken},records:[]}).runs.memory,undefined);
  for(const broken of [{...trail,map:99},{...trail,position:5.5},{...trail,collected:[0]},{...trail,collected:[2,2]},{...trail,complete:true}])assert.equal(M.restore({version:1,runs:{trail:broken},records:[]}).runs.trail,undefined);
  assert.deepEqual(M.restore(null),M.blank());
  assert.deepEqual(M.restore({version:2,runs:{},records:[]}),M.blank());
  assert.equal(M.addRecord(M.blank(),{runId:'x',gameId:'memory',score:Infinity,name:'N',date:1}).added,false);
  assert.equal(M.addRecord(M.blank(),{runId:'x',gameId:'fake',score:10,name:'N',date:1}).added,false);
});

test('rankings contain only saved results, filter each game and preserve first result for a runId',()=>{
  let state=M.blank();assert.deepEqual(M.ranking(state,'match3'),[]);
  for(let i=0;i<14;i++)state=M.addRecord(state,{runId:'r'+i,gameId:i%2?'memory':'match3',score:100+i,name:'Мой мишка',date:100+i}).state;
  assert.equal(M.ranking(state,'memory').length,7);
  assert.equal(M.ranking(state,'memory')[0].score,113);
  const result=M.addRecord(state,{runId:'r13',gameId:'memory',score:999,name:'Другой',date:200});
  assert.equal(result.added,false);assert.equal(M.ranking(result.state,'memory')[0].score,113);
  assert.deepEqual(M.restore(JSON.parse(JSON.stringify(state))),state);
});
