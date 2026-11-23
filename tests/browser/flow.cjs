const OUT=process.env.BEARLAB_QA_DIR||require('node:path').join(require('node:os').tmpdir(),'bearlab-demo-qa');require('node:fs').mkdirSync(OUT,{recursive:true});
const {chromium}=require(process.env.BEARLAB_PLAYWRIGHT||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{const b=await chromium.launch({executablePath:process.env.BEARLAB_CHROME||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader']});
const results=[];
for(const [name,width,height] of [['mobile',390,844],['desktop',1440,1000]]){
 const ctx=await b.newContext({viewport:{width,height},serviceWorkers:'block',acceptDownloads:true});const p=await ctx.newPage();const errors=[],failed=[];p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()>=400)failed.push(r.url()+' '+r.status())});
 const btn=(s)=>p.locator('#concept').getByRole('button',{name:s,exact:true});const snap=async(s)=>p.screenshot({path:`${OUT}/${name}-${s}.png`,timeout:10000});
 const nav=async(id,label)=>{if(width>760)await p.locator(`.st-side [data-route=${id}]`).click();else await p.locator('.cx-nav').getByRole('button',{name:label,exact:true}).click()};
 try{
 await p.goto((process.env.BEARLAB_BASE_URL||'http://127.0.0.1:8178/'),{waitUntil:'domcontentloaded'});await p.locator('[data-concept=home]').waitFor();
 await btn('Угостить').click();await snap('home');
 await nav('wardrobe','Гардероб');await p.getByRole('button',{name:'Сарафан +1 280 ₽',exact:true}).count();await p.locator('.st-outfit').filter({hasText:'Сарафан'}).click();
 assert.equal(await p.locator('.st-hero .st-bear-art').getAttribute('data-clothes'),'sundress boots');await snap('wardrobe');
 await btn('Посмотреть образ').click();await btn('В корзину').click();await p.locator('[data-concept=cart]').waitFor();
 await btn('Назад').click();await btn('Назад').click();await p.locator('.st-outfit').filter({hasText:'Худи'}).click();await btn('Посмотреть образ').click();await btn('В корзину').click();
 await p.waitForFunction(()=>JSON.parse(localStorage.getItem('bearlab.orders.v1')).cart.length===2);
 let state=await p.evaluate(()=>JSON.parse(localStorage.getItem('bearlab.orders.v1')));assert.equal(state.cart.length,2);assert.deepEqual(state.cart[0].cfg.clothes.slice().sort(),['boots','sundress']);assert.deepEqual(state.cart[1].cfg.clothes,['hoodie','sneakers']);
 await btn('Больше').first().click();await p.waitForTimeout(80);await snap('cart');
 await btn('К доставке').click();await btn('Создать заявку').click();await p.getByRole('alert').waitFor();
 await p.getByRole('textbox',{name:'Имя',exact:true}).fill('Демо');await p.getByRole('textbox',{name:'Телефон',exact:true}).fill('0000000000');
 await p.locator('.cx-opt').filter({hasText:'Курьер'}).click();await p.getByRole('textbox',{name:'Адрес',exact:true}).fill('Тестовая улица, 1');
 await p.locator('.cx-opt').filter({hasText:'Пункт выдачи'}).click();assert.equal(await p.getByRole('textbox',{name:'Адрес',exact:true}).count(),0);await snap('delivery');
 await btn('Создать заявку').click();await btn('Открыть заявку').click();await snap('assembly');
 state=await p.evaluate(()=>JSON.parse(localStorage.getItem('bearlab.orders.v1')));assert.equal(state.orders.length,1);assert.equal(state.orders[0].items.length,2);assert.equal(state.orders[0].items[0].quantity,2);
 const dPromise=p.waitForEvent('download');await btn('Скачать JSON').click();const d=await dPromise;const dest=OUT+'/'+name+'-order.json';await d.saveAs(dest);const data=JSON.parse(fs.readFileSync(dest,'utf8'));assert.equal(data.order.items.length,2);
 await p.reload({waitUntil:'domcontentloaded'});state=await p.evaluate(()=>JSON.parse(localStorage.getItem('bearlab.orders.v1')));assert.equal(state.orders.length,1);
 await p.getByRole('button',{name:'Настройки прототипа',exact:true}).click();await snap('settings');const dialog=p.getByRole('dialog',{name:'Настройки прототипа',exact:true});
 await dialog.getByRole('button',{name:'Игровой',exact:true}).click();assert.equal(await p.locator('body').getAttribute('data-theme'),'game');await p.getByRole('button',{name:'Закрыть настройки'}).click();await snap('game-home');
 // Fresh context import: no shared state or cache.
 const fresh=await b.newContext({viewport:{width,height},serviceWorkers:'block'});const q=await fresh.newPage();await q.goto((process.env.BEARLAB_BASE_URL||'http://127.0.0.1:8178/'),{waitUntil:'domcontentloaded'});await q.getByRole('button',{name:'Настройки прототипа',exact:true}).click();await q.locator('.st-screen-map').getByRole('button',{name:'Заявки',exact:true}).click();await q.getByRole('textbox',{name:'JSON заявки',exact:true}).fill(fs.readFileSync(dest,'utf8'));await q.locator('#concept').getByRole('button',{name:'Импорт JSON',exact:true}).click();await q.waitForTimeout(100);assert.equal(await q.evaluate(()=>JSON.parse(localStorage.getItem('bearlab.orders.v1')).orders[0].items.length),2);await fresh.close();
 assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);results.push({name,status:'PASS',checks:'home, dress, 2 snapshots, quantity, delivery validation/switch, checkout, download JSON, reload, settings/theme, clean import',errors,failed});
 }catch(e){await snap('FAIL').catch(()=>{});results.push({name,status:'FAIL',error:e.stack,errors,failed});}finally{await ctx.close()}
}
console.log(JSON.stringify(results,null,2));fs.writeFileSync(OUT+'/flow-results.json',JSON.stringify(results,null,2));await b.close();if(results.some(r=>r.status==='FAIL'))process.exit(1);
})().catch(e=>{console.error(e);process.exit(1)});
