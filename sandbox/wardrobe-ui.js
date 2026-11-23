/* Illustrated catalog; all choices update Dima's original cfg. */
window.BearLabWardrobe={install(api){
  const {e,art,config,go,icon}=api;
  const atlas=['hoodie','sundress','tshirt','sneakers','boots','glasses','patch','crown','pirate','cap','helmet','headphones','chain','bowtie','scarf','cape','watch','plaster','guitar'];
  const itemArt=id=>{const base={'hoodie-red':'hoodie','sundress-pink':'sundress'}[id]||id;const n=atlas.indexOf(base);return e('span',{class:'wd-item-art'+(id==='hoodie-red'?' wd-red':id==='sundress-pink'?' wd-pink':''),'aria-hidden':'true',style:`--wx:${(n<0?19:n)%5*25}%;--wy:${Math.floor((n<0?19:n)/5)*100/3}%`})};
  const button=(label,fn,cls='',kids=[])=>e('button',{type:'button',class:cls,'aria-label':label,onclick:fn},kids.length?kids:label);
  const all=()=>[...api.catalog.map(x=>({...x,kind:'clothes'})),...api.accessories.map(x=>({...x,kind:'acc'}))];
  const groups=[['top','Одежда','hoodie'],['feet','Обувь','sneakers'],['head','Головные уборы','cap'],['eyes','Очки и повязки','glasses'],['extras','Аксессуары','headphones']];
  let category='top',undo=null;
  const KEY='bearlab.looks.v1';
  function looks(){try{const v=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(v)?v.filter(x=>x&&typeof x.name==='string'&&Array.isArray(x.clothes)&&Array.isArray(x.acc)).slice(0,12):[]}catch(_){return []}}
  function saveLooks(v){try{localStorage.setItem(KEY,JSON.stringify(v));return true}catch(_){api.toast('Не удалось сохранить образ');return false}}
  function apply(clothes,acc){const c=config();undo={clothes:[...c.clothes],acc:[...(c.acc||[])]};api.setClothes(clothes);api.setAcc(acc);api.styled();api.render()}
  function repaint(label){const old=document.querySelector('.wd-items'),left=old?.scrollLeft||0,top=old?.scrollTop||0;api.render();const tray=document.querySelector('.wd-items');if(tray){tray.scrollLeft=left;tray.scrollTop=top}[...document.querySelectorAll('.wd-view button')].find(x=>x.getAttribute('aria-label')===label)?.focus({preventScroll:true})}
  function choose(it){const c=config();undo={clothes:[...c.clothes],acc:[...(c.acc||[])]};let ids=[...(c[it.kind]||[])];if(ids.includes(it.id))ids=ids.filter(id=>id!==it.id);else{ids=ids.filter(id=>all().find(x=>x.id===id)?.slot!==it.slot);ids.push(it.id)}if(it.kind==='clothes')api.setClothes(ids);else api.setAcc(ids);api.styled();repaint(it.label)}
  function collection(){const saved=looks();const c=config();api.open('Моя коллекция',[
    e('p',{class:'gm-lead'},'Сохранённые образы вашего мишки. Одежда и аксессуары меняются вместе; характер и тело остаются вашими.'),
    button('Сохранить текущий образ',()=>{if(saved.length>=12){api.toast('В коллекции уже 12 образов. Удалите ненужный.');return}const input=document.getElementById('wd-look-name');const name=(input?.value||'Мой образ '+(saved.length+1)).trim().slice(0,32);const record={name:name||'Мой образ',clothes:[...c.clothes],acc:[...(c.acc||[])]};if(saveLooks([...saved,record])){api.toast('Образ сохранён');collection()}},'gm-primary'),
    e('label',{class:'wd-name'},['Название образа',e('input',{id:'wd-look-name',maxlength:32,placeholder:'Например, прогулка в парке'})]),
    e('div',{class:'wd-saved'},saved.length?saved.map((o,i)=>e('article',{class:'wd-saved-card'},[
      e('strong',{},o.name),e('div',{class:'wd-look-items'},[...o.clothes,...o.acc].slice(0,4).map(itemArt)),
      button('Надеть '+o.name,()=>{apply(o.clothes.filter(id=>api.catalog.some(x=>x.id===id)),o.acc.filter(id=>api.accessories.some(x=>x.id===id)));api.close();go('wardrobe')},'gm-primary'),
      button('Удалить '+o.name,()=>{const next=saved.filter((_,j)=>j!==i);if(saveLooks(next))collection()},'gm-secondary')
    ])):e('p',{class:'gm-note'},'Здесь появятся ваши сочетания. Соберите образ в гардеробе и сохраните его.')),
    button('В гардероб',()=>{api.close();go('wardrobe')},'gm-secondary')
  ],'gm-wide')}
  function view(){const c=config(),shown=all().filter(it=>category==='extras'?!['top','feet','head','eyes'].includes(it.slot):it.slot===category);return e('div',{class:'cx-view gm-wardrobe wd-view','data-concept':'wardrobe'},[
    e('header',{class:'gm-page-top'},[button('Домой',()=>go('home'),'gm-back',[icon('home')]),e('h1',{},'Гардероб'),button('Мои образы',collection,'wd-save',[icon('wardrobe'),e('span',{},'Образы')])]),
    e('div',{class:'gm-dressing wd-dressing'},[
      e('nav',{class:'wd-rail','aria-label':'Категории гардероба'},groups.map(([id,label,image])=>e('button',{type:'button','aria-label':label,'aria-pressed':String(category===id),onclick:()=>{category=id;repaint(label)}},[itemArt(image),e('span',{},label)]))),
      e('section',{class:'gm-fitting wd-fitting'},[e('div',{class:'gm-dressed cx-hero'},[e('div',{class:'gm-fitting-glow'}),art(c)]),e('div',{class:'gm-fit-name'},[e('strong',{},c.name||'Мой мишка'),e('small',{},'Выбранные вещи уже надеты')]),button('Цвет и детали',()=>go('workshop'),'gm-fit-edit')]),
      e('section',{class:'gm-closet wd-closet'},[
        e('div',{class:'wd-catalog-heading'},[e('div',{},[e('small',{},'МОЙ ГАРДЕРОБ'),e('h2',{},groups.find(x=>x[0]===category)[1])]),e('span',{},shown.length+' вещей')]),
        e('div',{class:'gm-garments wd-items'},shown.map(it=>{const worn=(c[it.kind]||[]).includes(it.id);return e('button',{type:'button',class:'gm-garment wd-item','aria-label':it.label,'aria-pressed':String(worn),onclick:()=>choose(it)},[itemArt(it.id),e('strong',{},it.label),e('small',{class:worn?'wd-worn':''},worn?'✓ Надето':'Примерить')])})),
        e('div',{class:'wd-footer'},[undo?button('Отменить примерку',()=>{const prev=undo;api.setClothes(prev.clothes);api.setAcc(prev.acc);undo=null;api.render()},'gm-secondary'):e('p',{class:'gm-note'},'Нажмите вещь для примерки. Нажмите ещё раз, чтобы снять.'),button('Готово — домой',()=>go('home'),'gm-primary'),button('Сохранить образ',collection,'wd-save-link')]),
        e('details',{class:'wd-presets'},[e('summary',{},'Базовые комплекты'),e('div',{class:'gm-outfits'},api.outfits.map(o=>button(o.name,()=>apply([...o.clothes],c.acc||[]),'gm-outfit',[art({...c,clothes:o.clothes},false,true),e('strong',{},o.name)])))])
      ])
    ]),api.nav('')
  ])}
  return {view,collection,itemArt};
}};
