'use strict';
const {chromium}=require(process.env.BEARLAB_PLAYWRIGHT||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const OUT=process.env.BEARLAB_QA_DIR||path.join(require('node:os').tmpdir(),'bearlab-demo-qa');fs.mkdirSync(OUT,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.BEARLAB_CHROME||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader']});
 const results=[];
 for(const [name,width,height] of [['small',360,640],['phone',390,844],['landscape',844,390],['desktop',1440,900]]){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block',acceptDownloads:true});
  const page=await context.newPage(),errors=[],failed=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push(r.url()+' '+r.status())});
  const button=label=>page.getByRole('button',{name:label,exact:true});
  const snap=label=>page.screenshot({path:path.join(OUT,`${name}-game-${label}.png`),animations:'disabled'});
  const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('bearlab.pet.v1')));
  const close=()=>button('Закрыть').click();
  const home=()=>page.locator('.gm-nav').getByRole('button',{name:'Дом',exact:true}).click();
  try{
   await page.goto(process.env.BEARLAB_BASE_URL||'http://127.0.0.1:8180/',{waitUntil:'networkidle'});
   assert.equal(await page.locator('body').getAttribute('data-theme'),'game');
   await page.locator('.gm-home').waitFor();await page.evaluate(()=>document.fonts.ready);
   assert.equal(await page.locator('.gm-main-actions button').count(),4);assert.equal(await page.locator('.gm-nav button').count(),5);
   const rect=await page.locator('.gm-pet .st-bear-art').boundingBox();assert(rect&&rect.height>150&&rect.width>150,'bear visible');
   const outside=await page.locator('.gm-home button').evaluateAll(nodes=>nodes.filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.height&&(r.x<-1||r.y<-1||r.right>innerWidth+1||r.bottom>innerHeight+1)}).map(n=>n.getAttribute('aria-label')));assert.deepEqual(outside,[]);
   await snap('home');
   await button('Кормить').click();await snap('feed');await button('Медовый десерт').click();assert.equal((await state()).food,90);assert.equal((await state()).fed,true);
   await button('Награды').click();await button('Забрать подарок').click();assert.equal((await state()).coins,4350);
   await button('Награды').click();assert.equal(await button('Забрать подарок').count(),0);await close();
   await button('События').click();await button('Начать приключение').click();assert.equal(await button('Выполните все три задания').isDisabled(),true);await close();
   await button('Одеть').click();await button('Сарафан').first().click();assert.equal(await page.locator('.gm-outfit[aria-pressed=true]').evaluate(n=>n===document.activeElement),true);assert.match(await page.locator('.gm-dressed .st-bear-art').getAttribute('data-clothes'),/sundress/);
   await button('Обувь').click();assert.equal(await button('Обувь').evaluate(n=>n===document.activeElement),true);assert.equal(await page.locator('.gm-garment').count(),2);await button('Ботинки').click();assert(!((await page.locator('.gm-dressed .st-bear-art').getAttribute('data-clothes')).includes('boots')));await button('Ботинки').click();await button('Всё').click();await snap('wardrobe');
   await home();await button('Исследовать').click();await snap('world');await button('Лаборатория').first().click();await page.locator('body[data-screen=workshop]').waitFor();await page.locator('#cx-back').click();await page.locator('.gm-world').waitFor();await home();
   await button('Задания').click();await snap('tasks');await button('Забрать награду').click();assert.equal((await state()).coins,4500);assert.equal((await state()).stars,323);
   await button('Задания').click();assert.equal(await button('Награда получена').isDisabled(),true);await close();
   await page.reload();await page.locator('.gm-home').waitFor();assert.equal((await state()).claimed,true);assert.equal((await state()).coins,4500);
   await button('Коллекция').click();await snap('collection');await button('Худи').click();await page.locator('.gm-wardrobe').waitFor();await home();
   await button('Рюкзак').click();await snap('backpack');await button('Угощения').click();await page.getByRole('dialog',{name:'Время вкусненького'}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('.gm-overlay').count(),0);
   await button('Магазин').click();await snap('shop');await button('Посмотреть моего мишку').click();await page.locator('[data-concept=look]').waitFor();await snap('look');await page.locator('#concept').getByRole('button',{name:'В корзину',exact:true}).click();await page.locator('[data-concept=cart]').waitFor();assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('bearlab.orders.v1')).cart.length),1);await snap('cart');
   if(name==='phone'){
    await button('К доставке').click();await button('Создать заявку').click();await page.getByRole('alert').waitFor();await page.getByRole('textbox',{name:'Имя',exact:true}).fill('Демо');await page.getByRole('textbox',{name:'Телефон',exact:true}).fill('0000000000');await snap('delivery');await button('Создать заявку').click();await snap('confirmation');await button('Открыть заявку').click();await snap('assembly');const download=page.waitForEvent('download');await button('Скачать JSON').click();const file=await download;await file.saveAs(path.join(OUT,'game-order.json'));assert.equal(JSON.parse(fs.readFileSync(path.join(OUT,'game-order.json'),'utf8')).order.items.length,1);
   }
   await button('Настройки прототипа').click();await page.locator('.st-screen-map').getByRole('button',{name:'Дом',exact:true}).click();
   await button('Играть').click();await page.locator('.cx-grid').waitFor();await snap('match3');
   for(let turn=0;turn<12;turn++){await button('Подсказка').click();const cells=page.locator('.cx-gem.cx-hint');assert.equal(await cells.count(),2);const pressed=await cells.nth(0).getAttribute('aria-pressed');await cells.nth(pressed==='true'?1:0).click()}
   await page.locator('[data-concept=result]').waitFor();await snap('result');const after=(await state()).coins;assert(after>4500);await button('Домой').click();assert.equal((await state()).coins,after);
   if(name==='phone'||name==='desktop'){
    await button('Настройки прототипа').click();await page.getByRole('dialog',{name:'Настройки прототипа'}).getByRole('button',{name:'3D',exact:true}).click();await button('Закрыть настройки').click();await page.locator('.gm-pet canvas').waitFor({state:'visible'});await page.waitForTimeout(1500);assert.equal(await page.locator('body').getAttribute('data-bear'),'on');const canvas=await page.locator('.gm-pet canvas').boundingBox();assert(canvas.width>100&&canvas.height>100);await snap('3d');await button('Настройки прототипа').click();await page.getByRole('dialog',{name:'Настройки прототипа'}).getByRole('button',{name:'2D',exact:true}).click();await button('Закрыть настройки').click();
   }
   await button('Настройки прототипа').click();const settings=page.getByRole('dialog',{name:'Настройки прототипа'});await settings.getByRole('button',{name:'Выкл',exact:true}).click();assert.equal(await page.locator('body').getAttribute('data-motion'),'off');await settings.getByRole('button',{name:'Студия',exact:true}).click();await button('Закрыть настройки').click();await page.locator('.st-workspace').waitFor();assert.equal(await page.locator('.gm-home').count(),0);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('bearlab.orders.v1')).cart.length),name==='phone'?0:1);
   assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);results.push({name,status:'PASS',checks:'reference layout, care, gift once, tasks once, clothes/filter, world/workshop return, reload, collection, backpack/Escape, shop/cart, full round/reward, studio switch',errors,failed});
  }catch(error){await snap('FAIL').catch(()=>{});results.push({name,status:'FAIL',error:error.stack,errors,failed})}finally{await context.close()}
 }
 fs.writeFileSync(path.join(OUT,'game-ui-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));await browser.close();if(results.some(x=>x.status==='FAIL'))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
