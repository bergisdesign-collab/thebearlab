'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
(async()=>{
 let server;
 try{
  if(!process.env.BEARLAB_BASE_URL){
   server=http.createServer((req,res)=>{let file;try{file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(file===root)file=path.join(root,'index.html');if(!file.startsWith(root+path.sep))throw Error();}catch{res.writeHead(400).end();return}fs.readFile(file,(err,data)=>{if(err){res.writeHead(404).end();return}res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(data)})});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.BEARLAB_BASE_URL='http://127.0.0.1:'+server.address().port+'/';
  }
  for(const test of ['game-ui','flow','extended','resilience','three','workshop']){
   console.log('Browser check:',test);
   const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(__dirname,test+'.cjs')],{stdio:'inherit',env:process.env});child.once('error',reject);child.once('exit',resolve)});
   if(code!==0)throw Error(test+' failed with '+code);
  }
  console.log('ALL BROWSER CHECKS PASS');
 }finally{server?.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
