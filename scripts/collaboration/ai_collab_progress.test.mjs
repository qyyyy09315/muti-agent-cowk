import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ProgressBus,routeProgressReplies,bindInboxProgress} from './ai_collab_progress_bus.mjs';
import {installTaskExecution} from './ai_collab_task_compat.mjs';
test('remote outbox retries with identical idempotency key and persists a canonical peer answer for the active CLI',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collab-progress-'));let fail=true,sent=[],history=[];
 const client={sendMessage:async input=>{sent.push(input);if(fail)throw new Error('lost network');return {message:{id:'msg_question'}};},listMessages:async()=>history};
 const cfg={projectId:'p',agentId:'codex',progressPeerAgent:'grok'};
 try{
  const ctx={task:{id:'task_one',title:'task'},run:{id:'run_one'},workspaceDir:path.join(dir,'workspace')};
  let bus=new ProgressBus(client,cfg,dir,()=>{});const mailbox=bus.attach(ctx);
  fs.writeFileSync(path.join(mailbox,'requests','12345678-abcd.json'),JSON.stringify({type:'ask',stage:'compile',text:'Need advice; api_key=secret'}));
  await bus.pump();assert.equal(bus.state.pending.length,1);assert.ok(!sent[0].content.includes('=secret'));const key=sent[0].idempotencyKey;
  bus=new ProgressBus(client,cfg,dir,()=>{});fail=false;await bus.pump();assert.equal(sent.at(-1).idempotencyKey,key);assert.equal(bus.state.questions.length,1);
  history=[{id:'wrong',projectId:'other',taskId:'task_one',threadId:'progress:run_one',replyToId:'msg_question',fromAgent:'grok',toAgent:'codex',content:'wrong'}];
  await bus.pump();assert.equal(bus.state.questions.length,1);
  history.push({...history[0],id:'answer',projectId:'p',content:'Check package cache'});await bus.pump();
  const answer=JSON.parse(fs.readFileSync(path.join(mailbox,'responses','12345678-abcd.json'),'utf8'));
  assert.equal(answer.replies.length,1);assert.equal(answer.replies[0].content,'Check package cache');assert.equal(bus.state.questions.length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('progress replies do not open a second editor; new discussion questions retain the responder path',async()=>{
 let invoked=0,reply=true;class Listener{constructor(){this.client={listMessages:async()=>[{id:'msg',replyToId:reply?'question':null}]};}async receive(){invoked++;}}
 routeProgressReplies(Listener);const listener=new Listener();
 const event={taskId:'task',payload:{messageId:'msg',threadId:'progress:run_one'}};
 await listener.receive(event,new AbortController().signal);assert.equal(invoked,0);
 reply=false;await listener.receive(event,new AbortController().signal);assert.equal(invoked,1);
});
test('pipeline milestone reporting preserves checkin and confirms delivery only after Hub submit',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collab-pipeline-'));const previous=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=dir;
 const sent=[];let goal='';
 const runner={config:{taskWorkspaceBaseDir:'old'},client:{submitRun:async()=>({ok:true}),sendMessage:async input=>{sent.push(input);return {message:{id:'msg_'+sent.length}};},request:async()=>[],listMessages:async()=>[]},uvcs:{getStatus:async()=>({branch:'/main/ai/task_one/codex'}),checkin:async()=>'cs:42'},adapter:{executeTask:async ctx=>{goal=ctx.task.goal;ctx.onLog('patch: completed');return {success:true};}},executePipeline:async(task,run)=>{
  await runner.adapter.executeTask({task,run,workspaceDir:dir});await runner.uvcs.checkin(dir);await runner.client.submitRun({changesetSpec:'cs:42'});
 }};
 try{
  installTaskExecution(runner,{progressReportingEnabled:true,profileDir:dir,progressPeerAgent:'peer-b',taskWorkspaceRoot:dir,projectId:'p',agentId:'codex',unityEditor:'Unity.exe'});
  await runner.executePipeline({id:'task_one',title:'test',goal:'goal'},{id:'run_one'});
  assert.match(goal,/ask --mailbox/);assert.match(goal,/report --mailbox/);
  assert.ok(sent.some(x=>x.content.includes('文件修改节点完成')));
  assert.ok(sent.findIndex(x=>x.content.includes('任务分支签入成功'))<sent.findIndex(x=>x.content.includes('交付已确认')));
  assert.equal(sent.filter(x=>x.content.includes('交付已确认')).length,1);assert.equal(runner.config.taskWorkspaceBaseDir,'old');
 }finally{if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;fs.rmSync(dir,{recursive:true,force:true});}
});
test('editable inbox gets a progress mailbox; a remote discussion never starts another editing report loop',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collab-inbox-report-'));let prompt='',sent=[];
 class Bridge{async deliver(value){prompt=value;return 'done';}}
 const cfg={projectId:'p',agentId:'codex',progressPeerAgent:'peer-b',messageWorkspaceDir:dir};
 const bus=new ProgressBus({sendMessage:async input=>{sent.push(input);return {message:{id:'m'}};}},cfg,dir,()=>{});
 try{
  bindInboxProgress(Bridge,bus,cfg);const bridge=new Bridge();
  await bridge.deliver(JSON.stringify({task:{id:'t',title:'request'},incoming:{id:'msg_one',threadId:'normal'}}),new AbortController().signal);
  assert.match(prompt,/report --mailbox/);assert.equal(sent.length,2);assert.equal(bus.contexts.size,0);
  await bridge.deliver(JSON.stringify({task:{id:'t'},incoming:{id:'msg_two',threadId:'progress:run_one'}}),new AbortController().signal);
  assert.equal(sent.length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('real credential-free helper subprocess asks and prints the answer written by the parent',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collab-helper-'));
 const cfg={projectId:'p',agentId:'codex',progressPeerAgent:'grok'};
 const client={sendMessage:async()=>({message:{id:'question'}}),listMessages:async()=>[{id:'answer',projectId:'p',taskId:'t',threadId:'progress:run_test',replyToId:'question',fromAgent:'grok',toAgent:'codex',content:'Use option A'}]};
 try{
  const bus=new ProgressBus(client,cfg,dir,()=>{});const mailbox=bus.attach({task:{id:'t',title:'t'},run:{id:'run_test'},workspaceDir:dir});
  const child=promisify(execFile)(process.execPath,[fileURLToPath(new URL('./ai_collab_progress.mjs',import.meta.url)),'ask','--mailbox',mailbox,'--text','Which option?','--wait-seconds','5'],{timeout:10000});
  for(let n=0;n<30&&!fs.readdirSync(path.join(mailbox,'requests')).some(x=>x.endsWith('.json'));n++)await new Promise(r=>setTimeout(r,30));
  await bus.pump();const result=await child;assert.match(result.stdout,/Use option A/);assert.match(result.stdout,/queued/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
