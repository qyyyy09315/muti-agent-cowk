import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildServer} from '../src/server.js';
import {MemoryStorageEngine} from '../src/db.js';
test('live progress discussions preserve leased task state; ordinary peer requests still wait',async()=>{
 const previous=process.env.HUB_AUTH_MODE;process.env.HUB_AUTH_MODE='off';
 const storage=new MemoryStorageEngine();const app=await buildServer({storage});
 try{
  await app.inject({method:'POST',url:'/api/projects',payload:{id:'p',name:'p',uvcsRepo:'r'}});
  const created=await app.inject({method:'POST',url:'/api/tasks',payload:{projectId:'p',title:'test',goal:'test',acceptanceCriteria:'test',assignedAgent:'codex'}});
  assert.equal(created.statusCode,201);const task=created.json();
  await storage.updateTaskState(task.id,'leased');
  const input={projectId:'p',taskId:task.id,threadId:'progress:run_test',fromAgent:'codex',toAgent:'grok',content:'compile complete',idempotencyKey:'progress-test'};
  const first=await app.inject({method:'POST',url:'/api/messages',payload:input});assert.equal(first.statusCode,201);
  assert.equal((await storage.getTask(task.id))?.state,'leased');
  const duplicate=await app.inject({method:'POST',url:'/api/messages',payload:input});assert.equal(duplicate.statusCode,200);
  const normal=await app.inject({method:'POST',url:'/api/messages',payload:{...input,threadId:'normal',idempotencyKey:'ordinary'}});assert.equal(normal.statusCode,201);
  assert.equal((await storage.getTask(task.id))?.state,'waiting_peer');
 }finally{await app.close();if(previous===undefined)delete process.env.HUB_AUTH_MODE;else process.env.HUB_AUTH_MODE=previous;}
});
