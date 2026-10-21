import fs from 'node:fs';
import path from 'node:path';

export function routeProposal(text){
 if(typeof text!=='string'||!/接管|接替|替换|路由|handoff|route|toAgent\s*[=:：]/i.test(text))return null;
 if(/不要更新路由|不更改路由|do not (?:change|update) (?:the )?route/i.test(text))return null;
 const explicit=[...text.matchAll(/\btoAgent\s*[=:：]\s*[`"']?([a-zA-Z][a-zA-Z0-9_-]{0,63})/g)].map(m=>m[1]);
 const candidates=[...new Set(explicit)];
 if(candidates.length!==1)return null;
 return candidates[0];
}
// Hosts inject a read-only registry verifier; absent verification fails closed.
export async function verifyOnlinePeer(){return null;}
export class RouteManager{
 constructor(client,cfg,profile,{verify=verifyOnlinePeer,onChanged=()=>{},log=console.log}={}){
  this.client=client;this.cfg=cfg;this.profile=profile;this.verify=verify;this.onChanged=onChanged;this.log=log;
  this.file=path.join(profile,'peer-route-state.json');this.configFile=path.join(profile,'worker-config.json');
  this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{processed:[],pending:[],audit:[]};
 }
 save(){fs.mkdirSync(this.profile,{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.state,null,2));fs.renameSync(tmp,this.file);}
 consider(message,history){const result=(this.serial||Promise.resolve()).then(()=>this.apply(message,history));this.serial=result.catch(()=>{});return result;}
 async apply(message,history){
  const own=this.cfg.agentId||'codex',previous=this.cfg.progressPeerAgent||'grok';
  if(!message?.id||message.projectId!==this.cfg.projectId||message.toAgent!==own||message.fromAgent===own)return false;
  if(this.state.processed.includes(message.id))return true;
  const candidate=routeProposal(message.content);if(!candidate||candidate===own)return false;
  const timestamp=Date.parse(message.createdAt);
  if(!Number.isFinite(timestamp)||timestamp<Date.now()-86400000||timestamp>Date.now()+300000||timestamp<Date.parse(this.state.lastChangedAt||'1970-01-01'))return false;
  // A successor must reply to our existing request to the current peer in this exact thread.
  const anchor=history.find(m=>m.id===message.replyToId&&m.projectId===message.projectId&&m.taskId===message.taskId&&m.threadId===message.threadId&&m.fromAgent===own&&m.toAgent===previous);
  if(message.fromAgent!==previous&&!(candidate===message.fromAgent&&anchor))return false;
  if(candidate===previous){this.state.processed.push(message.id);this.save();return true;}
  let proof;try{proof=await this.verify(candidate);}catch{}
  if(!proof){if(!this.state.pending.some(m=>m.id===message.id)){this.state.pending.push(message);this.save();}this.log('[Route]: successor not yet verified online; current peer retained');return true;}
  const nextCfg=JSON.parse(fs.readFileSync(this.configFile,'utf8').replace(/^\uFEFF/,''));
  if((nextCfg.progressPeerAgent||'grok')!==previous)throw new Error('Peer changed concurrently; refusing stale route update');
  nextCfg.progressPeerAgent=candidate;nextCfg.peerRouteUpdatedAt=new Date().toISOString();nextCfg.peerRouteSourceMessageId=message.id;
  const tmp=this.configFile+'.route.tmp';fs.writeFileSync(tmp,JSON.stringify(nextCfg,null,2)+'\n');fs.renameSync(tmp,this.configFile);
  this.cfg.progressPeerAgent=candidate;this.cfg.peerRouteUpdatedAt=nextCfg.peerRouteUpdatedAt;
  this.onChanged(previous,candidate);
  this.state.processed=[...this.state.processed,message.id].slice(-1024);this.state.pending=this.state.pending.filter(m=>m.id!==message.id);
  this.state.lastChangedAt=message.createdAt;
  this.state.audit.push({at:nextCfg.peerRouteUpdatedAt,previous,next:candidate,messageId:message.id,taskId:message.taskId,workerId:proof.workerId});this.state.audit=this.state.audit.slice(-100);this.save();
  this.log(`[Route updated]: ${previous} -> ${candidate}; message=${message.id}`);
  try{await this.client.sendMessage({projectId:message.projectId,taskId:message.taskId,threadId:message.threadId,fromAgent:own,toAgent:candidate,replyToId:message.id,content:`已按接管通知自动更新协作路由：${previous} → ${candidate}。后续节点汇报和协作提问发给 ${candidate}；本机身份仍为 ${own}，任务分派与权限未改变。已有交付仍需明确的审阅结论，本条不表示审阅通过。`,idempotencyKey:`route-ack:${own}:${message.id}`});}catch{this.log('[Route]: route applied; acknowledgment could not be delivered');}
  return true;
 }
 async considerEvent(event){
  if(event.type!=='message_sent'||event.projectId!==this.cfg.projectId)return false;
  const embedded=event.payload?.message;
  if((embedded?.toAgent??event.payload?.to)!==(this.cfg.agentId||'codex'))return false;
  const taskId=embedded?.taskId??event.taskId??event.payload?.taskId,thread=embedded?.threadId??event.payload?.threadId,id=embedded?.id??event.payload?.messageId;
  if(!taskId||!thread||!id)return false;
  const history=await this.client.listMessages(taskId,thread);const message=history.find(m=>m.id===id);
  return this.consider(message,history);
 }
 async bootstrap(){
  let cursor=0;
  for(let page=0;page<20;page++){
   const events=await this.client.listEvents(this.cfg.projectId,cursor);
   if(!events.length)break;
   for(const event of events.sort((a,b)=>a.id-b.id))await this.considerEvent(event);
   const next=Math.max(...events.map(e=>e.id));if(next<=cursor)break;cursor=next;
  }
 }
 async retryPending(){for(const message of [...this.state.pending]){const history=await this.client.listMessages(message.taskId,message.threadId);const canonical=history.find(m=>m.id===message.id);if(canonical)await this.consider(canonical,history);}}
}
export function installAutomaticRoutes(MessageListener,manager){
 const receive=MessageListener.prototype.receive;
 MessageListener.prototype.receive=async function(event,signal){
  signal.throwIfAborted();
  if(await manager.considerEvent(event))return;
  return receive.call(this,event,signal);
 };
}
