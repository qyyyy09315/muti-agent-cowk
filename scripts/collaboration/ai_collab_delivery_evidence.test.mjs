import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectCloudDelivery,stageNewDeliverables,bindInboxEvidence} from './ai_collab_delivery_evidence.mjs';
test('cloud retrieval reads the specified changeset from a cs:9 inbox without switching and verifies hashes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-read-'));const calls=[];const status={branch:'/main/ai/inbox/agent',changeset:'cs:9',repository:'repo'};
 try{
  const client={getStatus:async()=>status,execCm:async args=>{calls.push(args);fs.writeFileSync(args.find(a=>a.startsWith('--file=')).slice(7),'cloud file');return {stdout:''};}};
  const file='ProjectDocs/review.md',hash=createHash('sha256').update('cloud file').digest('hex');
  const result=await inspectCloudDelivery(client,{workspace:dir,changeset:'cs:11',files:[file],cacheRoot:dir,expectedHashes:{[file]:hash}});
  assert.equal(result.files[0].expectedHashMatched,true);assert.equal(result.workspaceSelectorUnchanged,true);assert.equal(calls[0][1],file+'#cs:11');assert.ok(!calls.some(a=>a.includes('switch')));
  await assert.rejects(inspectCloudDelivery(client,{workspace:dir,changeset:'cs:11',files:['ProjectDocs/../../secret'],cacheRoot:dir}),/Invalid/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('new file staging adds only project deliverables, never root logs or unrelated files',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-stage-'));const calls=[];
 try{
  fs.mkdirSync(path.join(dir,'Assets'));fs.mkdirSync(path.join(dir,'ProjectDocs'));fs.writeFileSync(path.join(dir,'Assets','New.cs'),'class New {}');fs.writeFileSync(path.join(dir,'ProjectDocs','review.md'),'review');
  fs.writeFileSync(path.join(dir,'ProjectDocs','debug.log'),'log');
  const client={execCm:async args=>{calls.push(args);return {stdout:args[0]==='status'?(args[1].endsWith('Assets')?path.join(dir,'Assets','New.cs'):[path.join(dir,'ProjectDocs','review.md'),path.join(dir,'ProjectDocs','debug.log')].join('\n')):''};}};
  const files=await stageNewDeliverables(client,dir);assert.deepEqual(files,['Assets/New.cs','ProjectDocs/review.md']);assert.ok(!calls.find(a=>a[0]==='add').join(' ').includes('debug.log'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('inbox receives current parent execution evidence and an explicit authorized read-only cache scope',async()=>{
 let prompt;class Bridge{deliver(value){prompt=value;return Promise.resolve('ok');}}
 bindInboxEvidence(Bridge,async()=>({formalWorkerRunning:true,baseline:{changeset:'cs:9'},deliveries:[{changeset:'cs:11',files:[{localCache:'private-cache/review.md'}]}]}));
 await new Bridge().deliver('Can you inspect the delivery?',new AbortController().signal);
 assert.match(prompt,/formalWorkerRunning/);assert.match(prompt,/private-cache\/review.md/);assert.match(prompt,/does not describe cloud/);
});
