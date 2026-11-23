/* Bounded, local snapshots of customized bears. Illustrations cover the base outfits;
   any edited anatomy, color or accessory uses a render of the actual configuration. */
window.BearPreview={create(api){
  const cache=new Map();
  const key=c=>JSON.stringify(Object.keys(c).filter(k=>k!=='outfit').sort().map(k=>[k,Array.isArray(c[k])?c[k].slice().sort():c[k]]));
  const needs=c=>(c.clothes||[]).some(id=>['tshirt','hoodie-red','sundress-pink'].includes(id))||Object.keys(api.defaults).some(k=>!['clothes','name','size'].includes(k)&&JSON.stringify(c[k])!==JSON.stringify(api.defaults[k]));
  function capture(c){
    if(!needs(c))return null;
    const id=key(c);if(cache.has(id))return cache.get(id);
    if(key(c)!==key(api.current())||!api.renderer||!api.ready())return null;
    const {THREE,renderer,scene}=api;api.sync();
    const subject=api.subject();if(!subject)return null;
    subject.updateMatrixWorld(true);
    const box=new THREE.Box3().setFromObject(subject),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    const camera=new THREE.PerspectiveCamera(30,1,.1,100),distance=Math.max(size.x,size.y)/(2*Math.tan(Math.PI/12))*1.12;
    camera.position.copy(center).add(new THREE.Vector3(0,0,distance));camera.lookAt(center);
    const width=320,target=new THREE.WebGLRenderTarget(width,width),previous=renderer.getRenderTarget(),pod=window.__pod,visible=pod?.visible;
    const pixels=new Uint8Array(width*width*4),canvas=document.createElement('canvas');canvas.width=canvas.height=width;
    try{
      if(pod)pod.visible=false;
      renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,width,width,pixels);
      const context=canvas.getContext('2d'),data=context.createImageData(width,width);
      for(let y=0;y<width;y++)data.data.set(pixels.subarray((width-1-y)*width*4,(width-y)*width*4),y*width*4);
      context.putImageData(data,0,0);const url=canvas.toDataURL('image/webp',.78);
      if(url.length>100000)return null;
      cache.set(id,url);if(cache.size>48)cache.delete(cache.keys().next().value);return url;
    }catch(_){return null}finally{renderer.setRenderTarget(previous);target.dispose();if(pod)pod.visible=visible}
  }
  return {needs,capture,isCurrent:c=>key(c)===key(api.current())};
}};
