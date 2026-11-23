'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
// Exercise the shipped engine, without browser or UI mocks.
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('const M={cols:'),html.indexOf('function queueResult()'));
function game(){return vm.runInNewContext(source+';({M,m3new,m3seed,m3find,m3try,m3swap,m3markHint,m3hasMove,m3shuffle})')}
const board=g=>JSON.stringify(g.M.board);
test('checking moves and requesting hints never mutate the board',()=>{
 const g=game();g.m3seed();const before=board(g);
 for(let r=0;r<7;r++)for(let c=0;c<5;c++){g.m3try(r,c,r,c+1);assert.equal(board(g),before)}
 assert.equal(g.m3hasMove(),true);g.m3markHint();assert.equal(board(g),before);
});
test('an invalid swap is completely undone without consuming a turn or points',()=>{
 const g=game();g.m3seed();const before=board(g);assert.equal(g.m3swap(0,0,0,1),false);
 assert.equal(board(g),before);assert.equal(g.M.moves,12);assert.equal(g.M.score,0);
});
test('fresh boards are settled and playable; a round reaches zero in twelve valid moves',()=>{
 const g=game();for(let round=0;round<100;round++){
  g.m3new();assert.equal(Object.keys(g.m3find()).length,0);assert.equal(g.m3hasMove(),true);
  for(let turn=0;turn<12;turn++){
   assert.equal(g.m3markHint(),true);const [a,b]=g.M.hint;
   assert.equal(g.m3swap(...a,...b),true);assert.equal(g.M.moves,11-turn);
   assert.equal(Object.keys(g.m3find()).length,0);
  }
  assert.ok(g.M.score>=360);
 }
});
