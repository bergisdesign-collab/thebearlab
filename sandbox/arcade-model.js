(function(root,factory){const model=factory();if(typeof module==='object'&&module.exports)module.exports=model;else root.BearLabArcadeModel=model})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const MAPS=[['S.*..','##.#.','.*.#.','.###.','...*H'],['S#...','.#.*.','.*.#.','##.#.','*...H'],['S..#.','.#*#.','.*...','.###.','...*H']];
  const GAMES=['match3','memory','trail'];
  const copy=x=>JSON.parse(JSON.stringify(x));
  const validId=x=>typeof x==='string'&&x.length>0&&x.length<=120;
  const integer=(x,min,max)=>Number.isInteger(x)&&x>=min&&x<=max;
  function blank(){return{version:1,runs:{},records:[]}}
  function cells(map){return MAPS[map].join('').split('')}
  function createMemory(id,random=Math.random){const cards=Array.from({length:12},(_,i)=>Math.floor(i/2));for(let i=11;i>0;i--){const j=Math.floor(random()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]]}return{id,gameId:'memory',cards,open:[],matched:[],attempts:0,complete:false}}
  function createTrail(id,map=0){return{id,gameId:'trail',map,position:cells(map).indexOf('S'),collected:[],steps:0,complete:false}}
  function flip(run,index){if(run.complete||!integer(index,0,11)||run.matched.includes(index)||run.open.includes(index))return run;const next=copy(run);if(next.open.length===2)next.open=[];next.open.push(index);if(next.open.length===2){next.attempts++;if(next.cards[next.open[0]]===next.cards[next.open[1]]){next.matched.push(...next.open);next.open=[];next.complete=next.matched.length===12}}return next}
  function move(run,index){if(run.complete||!integer(index,0,24))return run;const from=run.position;if(Math.abs(from%5-index%5)+Math.abs(Math.floor(from/5)-Math.floor(index/5))!==1||cells(run.map)[index]==='#')return run;const next=copy(run);next.position=index;next.steps++;if(cells(run.map)[index]==='*'&&!next.collected.includes(index))next.collected.push(index);next.complete=cells(run.map)[index]==='H'&&next.collected.length===3;return next}
  function score(run){return run.gameId==='memory'?run.matched.length/2*100:run.collected.length*100+(run.complete?600:0)}
  function finish(state,run,name,date=Date.now()){if(!run.complete||state.records.some(r=>r.runId===run.id))return{state,added:false};return addRecord(state,{runId:run.id,gameId:run.gameId,score:score(run),name,date})}
  function addRecord(state,record){if(!validRecord(record)||state.records.some(r=>r.runId===record.runId))return{state,added:false};const next=copy(state);next.records.push({...record,name:record.name.slice(0,40)});return{state:next,added:true}}
  function validRecord(r){return r&&validId(r.runId)&&GAMES.includes(r.gameId)&&integer(r.score,0,100000000)&&typeof r.name==='string'&&r.name.length<=40&&Number.isFinite(r.date)&&r.date>=0&&r.date<=8640000000000000}
  function validRun(r,key){if(!r||!validId(r.id)||r.gameId!==key||typeof r.complete!=='boolean')return false;
    if(key==='memory'){if(!Array.isArray(r.cards)||r.cards.length!==12||!r.cards.every(n=>integer(n,0,5))||Array.from({length:6},(_,n)=>r.cards.filter(v=>v===n).length).some(n=>n!==2)||!integer(r.attempts,0,1000000))return false;for(const k of ['open','matched'])if(!Array.isArray(r[k])||new Set(r[k]).size!==r[k].length||!r[k].every(n=>integer(n,0,11)))return false;if(r.open.length>2||r.matched.length%2||r.open.some(n=>r.matched.includes(n)))return false;for(let n=0;n<6;n++)if(r.matched.filter(i=>r.cards[i]===n).length%2)return false;return r.complete===(r.matched.length===12)&&r.attempts>=r.matched.length/2}
    if(key==='trail'){if(!integer(r.map,0,MAPS.length-1)||!integer(r.position,0,24)||!integer(r.steps,0,1000000)||!Array.isArray(r.collected)||r.collected.length>3||new Set(r.collected).size!==r.collected.length)return false;const grid=cells(r.map);return grid[r.position]!=='#'&&r.collected.every(i=>integer(i,0,24)&&grid[i]==='*')&&r.steps>=r.collected.length&&r.complete===(grid[r.position]==='H'&&r.collected.length===3)}return false;
  }
  function restore(raw){const state=blank();if(!raw||raw.version!==1||typeof raw.runs!=='object'||!Array.isArray(raw.records))return state;for(const game of ['memory','trail'])if(validRun(raw.runs?.[game],game))state.runs[game]=copy(raw.runs[game]);for(const r of raw.records)if(validRecord(r)&&!state.records.some(x=>x.runId===r.runId))state.records.push(copy(r));return state}
  function ranking(state,game){return state.records.filter(r=>r.gameId===game).slice().sort((a,b)=>b.score-a.score||a.date-b.date).slice(0,10)}
  return{MAPS,GAMES,blank,cells,createMemory,createTrail,flip,move,score,finish,addRecord,restore,ranking,validRun};
});
