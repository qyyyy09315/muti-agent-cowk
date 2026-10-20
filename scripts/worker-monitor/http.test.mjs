import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const directory=path.dirname(fileURLToPath(import.meta.url));

async function startMonitor(profile,env={}){
 const child=spawn(process.execPath,[path.join(directory,'server.mjs'),'--port','0','--profile',profile],{env:{...process.env,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let text='',errors='';child.stderr.on('data',b=>{errors+=b.toString()});
 const info=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Monitor startup timed out: '+errors)),10000);
  child.stdout.on('data',b=>{text+=b.toString();if(text.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(text.split('\n')[0]))}catch(e){reject(e)}}});
  child.once('error',e=>{clearTimeout(timer);reject(e)});
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('Monitor startup exited '+code+': '+errors))});
 });
 return {child,info,async stop(){if(child.exitCode!==null)return;const done=once(child,'exit');child.kill();await done;}};
}
test('loopback HTTP monitor degrades without config and rejects mutation/cross-site access',async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-http-'));
 fs.writeFileSync(path.join(profile,'worker-demo.stdout.log'),'Authorization: Bearer private-test-token\n');
 const service=await startMonitor(profile);
 try{
  const url=service.info.url;
  const response=await fetch(url+'/api/snapshot');assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.readOnly,true);assert.equal(body.local.configured,false);assert.equal(body.local.logs.source,'最新日志回退');assert.ok(!JSON.stringify(body).includes('private-test-token'));
  assert.equal((await fetch(url+'/api/snapshot',{method:'POST'})).status,405);
  assert.equal((await fetch(url+'/api/snapshot',{headers:{Origin:'https://other.example'}})).status,403);
  const status=await new Promise((resolve,reject)=>{const req=http.get(url+'/api/snapshot',{headers:{Host:'other.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject)});assert.equal(status,403);
  assert.equal((await fetch(url+'/missing')).status,404);
  const html=await fetch(url+'/');assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await html.text(),/ai-collab-monitor[\s\S]*read-only/i);
  assert.match(await(await fetch(url+'/style.css')).text(),/color-scheme:\s*light/);
 }finally{await service.stop();fs.rmSync(profile,{recursive:true,force:true});}
});
test('Windows collector reads mock Hub GET APIs, configured identity and messages without leaking token',{skip:process.platform!=='win32',timeout:20000},async()=>{
 const seen=[];
 const hub=http.createServer((req,res)=>{
  seen.push(req.method+' '+req.url);
  assert.equal(req.headers.authorization,'Bearer monitor-fixture-token');
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/workers')return res.end(JSON.stringify([{id:'worker-demo',agentType:'grok',hostname:'demo-host',status:'online',lastHeartbeatAt:new Date().toISOString()}]));
  if(req.url==='/api/projects/demo/tasks')return res.end(JSON.stringify([{id:'task-demo',title:'Demo task',state:'paused',projectId:'demo',updatedAt:new Date().toISOString()}]));
  if(req.url==='/api/projects/demo/messages?limit=100')return res.end(JSON.stringify([{id:'message-demo',content:'Hello from fixture',fromAgent:'codex',toAgent:'grok',createdAt:new Date().toISOString()}]));
  if(req.url.startsWith('/api/events?'))return res.end('[]');
  res.statusCode=404;res.end('{}');
 });
 hub.listen(0,'127.0.0.1');await once(hub,'listening');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-collector-'));
 fs.writeFileSync(path.join(profile,'worker-config.json'),JSON.stringify({username:'alice',agentType:'grok',workerId:'worker-demo',projectId:'demo',hubUrl:`http://127.0.0.1:${hub.address().port}`}));
 const service=await startMonitor(profile,{HUB_TOKEN:'monitor-fixture-token'});
 try{
  let data;
  for(let i=0;i<40;i++){data=await(await fetch(service.info.url+'/api/snapshot')).json();if(data.remote.hubOk)break;await delay(250);}
  assert.equal(data.remote.hubOk,true,data.remote.hubError);
  assert.equal(data.local.identity.agentType,'grok');assert.equal(data.ownWorker.id,'worker-demo');
  assert.equal(data.remote.messages[0].content,'Hello from fixture');assert.ok(!JSON.stringify(data).includes('monitor-fixture-token'));
  assert.ok(seen.length>=4);assert.ok(seen.every(request=>request.startsWith('GET ')));
 }finally{await service.stop();await new Promise(resolve=>hub.close(resolve));fs.rmSync(profile,{recursive:true,force:true});}
});
