import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bindInboxSession} from './ai_collab_message_compat.mjs';

function bridge(){return class {
 args(){return ['codex','exec','-C','old','resume','--last','-'];}
 deliver(prompt){this.prompt=prompt;return Promise.resolve('ok');}
};}
test('editable inbox enables shell execution and gives the real workspace while preserving publication boundaries',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inbox-test-'));
 try{
  const Bridge=bridge();bindInboxSession(Bridge,dir,'model',{editable:true,branch:'/main/ai/inbox_codex/codex',unityEditor:'Unity.exe'});
  const b=new Bridge();const args=b.args();
  assert.equal(args[args.indexOf('--sandbox')+1],'danger-full-access');
  assert.equal(args[args.indexOf('-C')+1],dir);assert.ok(!args.includes('--disable'));
  await b.deliver('Implement the requested feature');
  assert.match(b.prompt,/Do the requested work before replying/);assert.ok(b.prompt.includes(dir));
  assert.match(b.prompt,/Do not run cm checkin/);assert.match(b.prompt,/acquire the UVCS checkout lock/);assert.match(b.prompt,/-batchmode/);
  assert.doesNotMatch(b.prompt,/Do not execute project work/);assert.equal(b.timeoutMs,1200000);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('read-only mode remains available and incomplete editable config is rejected',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inbox-test-'));
 try{
  const Bridge=bridge();bindInboxSession(Bridge,dir);
  const args=new Bridge().args();assert.equal(args[args.indexOf('--sandbox')+1],'read-only');assert.ok(args.includes('shell_tool'));
  assert.throws(()=>bindInboxSession(bridge(),dir,undefined,{editable:true}),/requires a branch/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
