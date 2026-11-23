'use strict';
const {chromium}=require(process.env.BEARLAB_PLAYWRIGHT||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const OUT=process.env.BEARLAB_QA_DIR||'/tmp/bearlab-responsive-qa';fs.mkdirSync(OUT,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.BEARLAB_CHROME||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader']});
 const results=[];
 for(const [name,width,height] of [['phone',390,844],['small',360,640],['compact-landscape',667,375],['landscape',844,390],['tablet',768,1024],['tablet-landscape',1024,768],['desktop',1920,1080],['wide',2560,1080]].filter(([name])=>!process.env.BEARLAB_QA_CASES||process.env.BEARLAB_QA_CASES.split(',').includes(name))){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const button=label=>page.getByRole('button',{name:label,exact:true});
  const snap=label=>page.screenshot({path:path.join(OUT,`${name}-${label}.png`),animations:'disabled'});
  const bounds=async selector=>{const bad=await page.locator(selector).evaluateAll(ns=>ns.filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&(r.x<-.5||r.y<-.5||r.right>innerWidth+.5||r.bottom>innerHeight+.5)}).map(n=>n.getAttribute('aria-label')||n.textContent));assert.deepEqual(bad,[],selector+' outside viewport')};
  try{
   await page.goto(process.env.BEARLAB_BASE_URL||'http://127.0.0.1:8180/',{waitUntil:'networkidle'});await page.evaluate(()=>document.fonts.ready);await bounds('.gm-home button,.gm-comfort-launch');const covered=await page.locator('.gm-home button,.gm-comfort-launch').evaluateAll(ns=>ns.filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.height&&!n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}).map(n=>n.getAttribute('aria-label')));assert.deepEqual(covered,[],'home controls are not covered');await snap('home');
   await button('Удобство и управление').click();await button('Крупнее кнопки').click();await button('Ведущая рука').click();await button('Меньше движения').click();assert.equal(await page.locator('body').getAttribute('data-motion'),'off');assert.equal(await page.locator('body').getAttribute('data-targets'),'large');await page.keyboard.press('Escape');await bounds('.gm-home button,.gm-comfort-launch');await snap('large-left');
   await page.reload();assert.equal(await page.locator('body').getAttribute('data-hand'),'left');assert.equal(await page.locator('body').getAttribute('data-targets'),'large');
   await button('Одеть').click();await page.locator('.gm-wardrobe').waitFor();await button('Готово — мой образ').scrollIntoViewIfNeeded();await bounds('.gm-wardrobe .gm-nav button');await snap('wardrobe-large');await page.locator('.gm-nav').getByRole('button',{name:'Дом',exact:true}).click();
   await button('Удобство и управление').click();await button('Крупнее кнопки').click();await button('Ведущая рука').click();await page.keyboard.press('Escape');
   await page.keyboard.press('Alt+Digit4');await page.locator('.gm-world').waitFor();await bounds('.gm-place,.gm-world-card,.gm-nav button');await snap('world');
   await page.keyboard.press('Alt+Digit2');await page.locator('.cx-grid').waitFor();await bounds('.cx-gem,.cx-foot button,.gm-nav button');await snap('game');
   await page.locator('.cx-gem').first().focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('.cx-gem:focus').getAttribute('data-cell'),'1');await page.keyboard.press('ArrowDown');assert.equal(await page.locator('.cx-gem:focus').getAttribute('data-cell'),'7');await page.keyboard.press('Enter');assert.equal(await page.locator('.cx-gem:focus').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.cx-gem[tabindex="0"]').count(),1);await page.keyboard.press('Tab');assert.equal(await button('Подсказка').evaluate(n=>n===document.activeElement),true);
   await page.keyboard.press('Alt+Home');await page.locator('.gm-home').waitFor();await button('Настройки прототипа').click();await page.getByRole('textbox',{name:'Имя мишки'}).fill('Тоша');await page.keyboard.press('Alt+Digit4');assert.equal(await page.locator('.gm-home').count(),1);await page.keyboard.press('Escape');
   assert.deepEqual(errors,[]);results.push({name,width,height,status:'PASS',checks:'home bounds, comfort persistence, enlarged wardrobe, left hand, world, keyboard board/Tab/shortcuts/input guard',errors});
  }catch(error){await snap('FAIL').catch(()=>{});results.push({name,status:'FAIL',error:error.message,errors})}finally{await context.close()}
 }
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'}),page=await context.newPage();await page.goto(process.env.BEARLAB_BASE_URL||'http://127.0.0.1:8180/');assert.equal(await page.locator('body').getAttribute('data-motion'),'off');await context.close();
 fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));await browser.close();if(results.some(x=>x.status==='FAIL'))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
