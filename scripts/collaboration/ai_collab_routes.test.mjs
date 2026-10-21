import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RouteManager,routeProposal,installAutomaticRoutes} from './ai_collab_routes.mjs';
const fixture=()=>fs.mkdtempSync(path.join(os.tmpdir(),'collab-routes-'));
function messages(){
 const anchor={id:'request',projectId:'p',taskId:'task',threadId:'thread',fromAgent:'codex',toAgent:'grok'};
 const notice={id:'handoff',projectId:'p',taskId:'task',threadId:'thread',fromAgent:'codex-b',toAgent:'codex',replyToId:'request',content:'【接管通知】替代grok，后续请发 toAgent=codex-b',createdAt:new Date().toISOString()};
 return {anchor,notice};
}
test('explicit route parser rejects ambiguous destinations and negative instructions',()=>{
 assert.equal(routeProposal('接管，toAgent=codex-b'),'codex-b');
 assert.equal(routeProposal('toAgent=one 或 toAgent=two'),null);
 assert.equal(routeProposal('不要更新路由，示例toAgent=someone'),null);
 assert.equal(routeProposal('修改管理员权限'),null);
});
test('canonical linked handoff updates only peer routing, persists audit, acknowledges successor, and makes future reports use it',async()=>{
 const dir=fixture();try{
  const cfg={projectId:'p',agentId:'codex',username:'developer',progressPeerAgent:'grok',extra:'keep'};
  fs.writeFileSync(path.join(dir,'worker-config.json'),JSON.stringify(cfg));const sent=[];let changed;
  const manager=new RouteManager({sendMessage:async m=>sent.push(m)},cfg,dir,{verify:async id=>({agentId:id,workerId:'online-worker'}),onChanged:(old,next)=>{changed=[old,next];},log:()=>{}});
  const {anchor,notice}=messages();assert.equal(await manager.consider(notice,[anchor,notice]),true);
  assert.equal(cfg.progressPeerAgent,'codex-b');assert.equal(cfg.agentId,'codex');assert.deepEqual(changed,['grok','codex-b']);
  const disk=JSON.parse(fs.readFileSync(path.join(dir,'worker-config.json')));assert.equal(disk.extra,'keep');assert.equal(disk.username,'developer');assert.equal(disk.peerRouteSourceMessageId,'handoff');
  assert.equal(sent[0].toAgent,'codex-b');assert.equal(sent[0].replyToId,'handoff');
  assert.equal(await manager.consider(notice,[anchor,notice]),true);assert.equal(sent.length,1);
  assert.equal(manager.state.audit.length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('unsolicited sender, wrong project, stale notice and self-routing cannot redirect the Worker',async()=>{
 const dir=fixture();try{
  const cfg={projectId:'p',agentId:'codex',progressPeerAgent:'grok'};fs.writeFileSync(path.join(dir,'worker-config.json'),JSON.stringify(cfg));
  let probes=0;const manager=new RouteManager({},cfg,dir,{verify:async()=>{probes++;return {};},log:()=>{}});const {anchor,notice}=messages();
  for(const item of [{...notice,replyToId:null},{...notice,projectId:'other'},{...notice,createdAt:new Date(Date.now()-90000000).toISOString()},{...notice,content:'接管 toAgent=codex'}])assert.equal(await manager.consider(item,[anchor,item]),false);
  assert.equal(cfg.progressPeerAgent,'grok');assert.equal(probes,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('offline successor stays pending and applies only after canonical re-read and online verification',async()=>{
 const dir=fixture();try{
  const cfg={projectId:'p',agentId:'codex',progressPeerAgent:'grok'};fs.writeFileSync(path.join(dir,'worker-config.json'),JSON.stringify(cfg));
  const {anchor,notice}=messages();let online=false;
  const manager=new RouteManager({listMessages:async()=>[anchor,notice],sendMessage:async()=>({})},cfg,dir,{verify:async()=>online?{workerId:'online'}:null,log:()=>{}});
  assert.equal(await manager.consider(notice,[anchor,notice]),true);assert.equal(manager.state.pending.length,1);assert.equal(cfg.progressPeerAgent,'grok');
  online=true;await manager.retryPending();assert.equal(cfg.progressPeerAgent,'codex-b');assert.equal(manager.state.pending.length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('live route notification is consumed before normal progress-reply suppression',async()=>{
 let original=0;class Listener{async receive(){original++;}}
 installAutomaticRoutes(Listener,{considerEvent:async event=>event.route});const listener=new Listener();
 await listener.receive({route:true},new AbortController().signal);assert.equal(original,0);
 await listener.receive({route:false},new AbortController().signal);assert.equal(original,1);
});
