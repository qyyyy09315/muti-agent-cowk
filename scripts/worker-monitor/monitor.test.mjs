import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chooseLogs,readLocal,tail,redact,inspectSessions,allowedRequest,discoverProfile} from './core.mjs';
function fixture(){return fs.mkdtempSync(path.join(os.tmpdir(),'worker-monitor-test-'));}
test('profile selection uses explicit or unique config and rejects ambiguity',()=>{
 const dir=fixture();try{
  for(const name of ['alice','bob']){
   const profile=path.join(dir,'AI-Collab',name);fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'worker-config.json'),'{}');
   if(name==='alice')assert.equal(discoverProfile(dir),profile);
  }
  assert.throws(()=>discoverProfile(dir),/Multiple/);
  assert.equal(discoverProfile(dir,path.join(dir,'explicit')),path.join(dir,'explicit'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing metadata falls back to latest logs; invalid profile remains readable',()=>{
 const dir=fixture();try{
  fs.writeFileSync(path.join(dir,'worker-1.stdout.log'),'first\n');
  fs.writeFileSync(path.join(dir,'worker-2.stdout.log'),'second\n');
  const older=new Date(Date.now()-20000);fs.utimesSync(path.join(dir,'worker-1.stdout.log'),older,older);
  assert.equal(path.basename(chooseLogs(dir).stdout),'worker-2.stdout.log');
  assert.match(chooseLogs(dir).warnings[0],/缺失/);
  assert.equal(readLocal(path.join(dir,'missing')).configured,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('metadata cannot redirect monitor into an arbitrary credential file',()=>{
 const dir=fixture(),outside=path.join(os.tmpdir(),'monitor-outside-'+Date.now()+'.log');
 try{fs.writeFileSync(outside,'private');fs.writeFileSync(path.join(dir,'worker-process.json'),JSON.stringify({stdout:outside}));assert.equal(chooseLogs(dir).stdout,null);}
 finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(outside,{force:true});}
});
test('bounded tail handles UTF-8 and secrets are redacted before response',()=>{
 const dir=fixture();try{
  const file=path.join(dir,'worker.stdout.log');fs.writeFileSync(file,'x'.repeat(10000)+'\n最后一行\n');
  assert.equal(tail(file,100),'最后一行\n');
  const result=redact({token:'do-not-leak',nested:{password:'hidden'},logs:['Authorization: Bearer abcdef','api_key=super-secret','sk-12345678901234567890']});
  assert.equal(JSON.stringify(result).includes('super-secret'),false);assert.equal(JSON.stringify(result).includes('abcdef'),false);assert.equal('token' in result,false);
  assert.equal(redact('config: {"api_key":"another-secret"}').includes('another-secret'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('only this Worker sessions are read; internal reasoning is omitted',()=>{
 const dir=fixture(),date=new Date();
 try{
  const home=path.join(dir,'codex'),folder=path.join(home,'sessions',String(date.getFullYear()),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0'));fs.mkdirSync(folder,{recursive:true});
  const own=[{type:'session_meta',payload:{id:'own',cwd:path.join(dir,'message-session'),instructions:'x'.repeat(30000)}},{type:'response_item',payload:{type:'reasoning',summary:[{text:'private-reasoning'}]}},{type:'response_item',payload:{type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'private-channel'}]}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'公开回复'}]}}];
  fs.writeFileSync(path.join(folder,'own.jsonl'),own.map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(path.join(folder,'other.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'other',cwd:path.join(dir,'unrelated')}})+'\n');
  const sessions=inspectSessions(dir,{},home);assert.equal(sessions.length,1);assert.equal(sessions[0].turns[0].text,'公开回复');assert.equal(JSON.stringify(sessions).includes('private-reasoning'),false);assert.equal(JSON.stringify(sessions).includes('private-channel'),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('rejects DNS rebinding hosts and cross-site reads',()=>{
 assert.equal(allowedRequest({headers:{host:'evil.example:8787'}},8787),false);
 assert.equal(allowedRequest({headers:{host:'127.0.0.1:8787',origin:'https://evil.example'}},8787),false);
 assert.equal(allowedRequest({headers:{host:'127.0.0.1:8787','sec-fetch-site':'cross-site'}},8787),false);
 assert.equal(allowedRequest({headers:{host:'127.0.0.1:8787'}},8787),true);
});
