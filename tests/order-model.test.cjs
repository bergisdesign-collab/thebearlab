'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const orders = require('../sandbox/order-model.js');

function memory() {
  const data = new Map();
  return {getItem:key => data.get(key) ?? null, setItem:(key,value) => data.set(key,value)};
}
function draft() {
  return orders.addItem(orders.readState(memory()),{model:'parts',name:'Тоша',main:'#cf9',acc:['watch','cap']},3380);
}
test('snapshots editable configurations, groups identical examples and supports removal',() => {
  const cfg = {name:'Тоша',acc:['watch','cap']};
  const first = orders.addItem(orders.readState(memory()),cfg,500);
  cfg.acc.pop();
  cfg.name = 'Федя';
  assert.equal(first.cart[0].cfg.name,'Тоша');
  assert.deepEqual(first.cart[0].cfg.acc,['cap','watch']);
  const both = orders.addItem(first,{name:'Тоша',acc:['cap','watch']},500);
  assert.equal(both.cart.length,1);
  assert.equal(both.cart[0].quantity,2);
  assert.equal(first.cart[0].quantity,1);
  assert.equal(orders.setQuantity(both,both.cart[0].id,0).cart.length,0);
  assert.throws(() => orders.setQuantity(both,both.cart[0].id,100));
  assert.throws(() => orders.checkout(orders.readState(memory()),'pickup'));
});
test('freezes the exact order including original price, sides, optional layers, fixture delivery',() => {
  const state = draft();
  const next = orders.checkout(orders.setQuantity(state,state.cart[0].id,2),'courier');
  const order = next.orders[0], item = order.items[0];
  assert.equal(order.total,6760);
  assert.notEqual(order.items,state.cart);
  assert.equal(next.cart.length,0);
  assert.equal(order.deliveryId,'courier');
  assert.throws(() => orders.checkout(state,'some street'));
  assert.throws(() => orders.checkout(next,'courier'));
  assert.notEqual(orders.checkout(state,'pickup').orders[0].id,order.id);
  assert.deepEqual(item.assembly.map(a=>a.slot),'COLOR BODY HEAD FACE ARM_L HAND_L ARM_R HAND_R LEG_L FOOT_L LEG_R FOOT_R OUTFIT'.split(' '));
  assert.deepEqual(item.assembly.map(a=>a.step),Array.from({length:13},(_,i)=>'ASM-'+String(i+1).padStart(2,'0')));
  assert.equal(item.assembly[5].side,'L');
  assert.equal(item.assembly[7].parent,'ARM_R');
  assert.equal(item.assembly[4].attributes.color,'#cf9');
  assert.equal(item.assembly[0].sku,null);
  assert.equal(item.assembly[1].physical,'pending');
  assert.equal(item.assembly.at(-1).physical,'none');
  assert.deepEqual(item.accessories.map(a=>a.id),['cap','watch']);
  assert.throws(() => { item.cfg.main = '#999'; });
  assert.throws(() => { item.assembly[5].attributes.claws = true; });
  assert.deepEqual(orders.describe({headShape:'wide',model:'parts'})[2].variant,'Широкая');
});
test('separate browsers can exchange one validated JSON example and keep their own data',() => {
  const sender = orders.checkout(draft(),'pickup');
  const saved = memory();
  orders.writeState(sender,saved);
  assert.deepEqual(orders.readState(saved),sender);
  const json = orders.exportOrder(sender.orders[0]);
  const target = draft();
  const received = orders.importOrder(target,json);
  assert.deepEqual(received.orders[0],sender.orders[0]);
  assert.deepEqual(received.cart,target.cart);
  assert.deepEqual(orders.importOrder(received,json),received);
  const modified = JSON.parse(json);
  modified.order.items[0].unitPrice = modified.order.total = 555;
  assert.throws(() => orders.importOrder(received,JSON.stringify(modified)),/другим составом/);
});
test('validates hand-edited files, including derived totals, schema and tech cards',() => {
  const sample = orders.checkout(draft(),'courier').orders[0];
  const empty = orders.readState(memory());
  const changes = [
    doc => {doc.version=2;}, doc=>{doc.order.catalogVersion='new';}, doc => {doc.order.total++;},
    doc => {doc.order.createdAt='2026-02-31T00:00:00.000Z';},
    doc => {doc.order.items[0].cfg.main='javascript:x';}, doc=>{doc.order.telephone='x';},
    doc => {doc.order.items[0].assembly[4].side='R';},
    doc => {doc.order.items[0].assembly[4].physical='yes';}, doc=>{doc.order.items[0].quantity=-1;},
    doc => {doc.order.items[0].cfg.acc=['unknown'];},
    doc => {doc.order.items[0].cfg.acc=['glasses','patch'];},
    doc => {doc.order.items[0].cfg.model='custom';}, doc=>{delete doc.order.items[0].assembly;}
  ];
  for (const change of changes) {
    const doc = JSON.parse(orders.exportOrder(sample));
    change(doc);
    assert.throws(() => orders.importOrder(empty,JSON.stringify(doc)));
  }
  assert.throws(() => orders.importOrder(empty,' '.repeat(400001)));
  assert.throws(() => orders.addItem(empty,{eyes:'__proto__'},100));
  assert.throws(() => orders.addItem(empty,JSON.parse('{"__proto__":{"x":1}}'),100));
  assert.throws(() => orders.addItem(empty,{},-1));
  assert.throws(() => orders.addItem(empty,{emotion:2},100));
});
test('garment references keep separate lines, physical parity and the existing v1 exchange format', () => {
  const blank = orders.readState(memory());
  let state = orders.addItem(blank,{},500);
  state = orders.addItem(state,{outfit:'base'},500);
  state = orders.addItem(state,{outfit:'hoodie'},500);
  state = orders.addItem(state,{outfit:'sundress'},500);
  assert.deepEqual(state.cart.map(line => [line.cfg.outfit,line.quantity]),[['base',2],['hoodie',1],['sundress',1]]);
  const ordered = orders.checkout(state,'courier').orders[0];
  const received = orders.importOrder(blank,orders.exportOrder(ordered)).orders[0];
  const garmentRows = received.items.map(line => line.assembly[12]);
  assert.deepEqual(garmentRows.map(row => [row.slot,row.attributes.outfit,row.variant,row.physical,row.sku]),[
    ['OUTFIT',null,'Без базового комплекта','none',null],
    ['OUTFIT','hoodie','Худи','pending',null],
    ['OUTFIT','sundress','Сарафан','pending',null]
  ]);
  assert.equal(received.total,2000);
  assert.ok(received.items.every(line => line.accessories.length === 0));
  assert.throws(() => orders.addItem(blank,{outfit:'unknown'},500));

  const old = orders.checkout(draft(),'pickup');
  const doc = JSON.parse(orders.exportOrder(old.orders[0]));
  delete doc.order.items[0].cfg.outfit;
  assert.deepEqual(orders.importOrder(blank,JSON.stringify(doc)).orders[0],old.orders[0]);
  const store = memory();
  orders.writeState(old,store);
  const stored = JSON.parse(store.getItem(orders.storageKey));
  delete stored.orders[0].items[0].cfg.outfit;
  store.setItem(orders.storageKey,JSON.stringify(stored));
  assert.deepEqual(orders.readState(store),old);
});
