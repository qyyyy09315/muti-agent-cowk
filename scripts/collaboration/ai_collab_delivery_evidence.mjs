import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export function safeDeliveryPath(file){
 if(typeof file!=='string'||file.includes('\\')||! /^(Assets|ProjectDocs|ProjectSettings|Packages)\//.test(file)||file.split('/').some(p=>!p||p==='.'||p==='..')||/[:#@\x00-\x1f]/.test(file))throw new Error('Invalid project delivery path');
 return file;
}
export async function inspectCloudDelivery(client,{workspace,changeset,files,cacheRoot,expectedHashes={}}){
 if(!/^cs:\d+$/.test(changeset))throw new Error('Use an explicit numeric changeset');
 if(!Array.isArray(files)||!files.length||files.length>64)throw new Error('Provide 1..64 explicit project files');
 files.forEach(safeDeliveryPath);
 const before=await client.getStatus(workspace),dir=path.join(cacheRoot,changeset.replace(':','_'));fs.mkdirSync(dir,{recursive:true});
 const verified=[];
 for(const file of files){
  const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});
  await client.execCm(['getfile',file+'#'+changeset,'--file='+target],workspace);
  const sha256=createHash('sha256').update(fs.readFileSync(target)).digest('hex').toUpperCase();
  if(expectedHashes[file]&&sha256!==expectedHashes[file].toUpperCase())throw new Error('Cloud delivery hash mismatch: '+file);
  verified.push({path:file,localCache:target,sha256,bytes:fs.statSync(target).size,expectedHashMatched:expectedHashes[file]?true:null});
 }
 const after=await client.getStatus(workspace);
 if(before.branch!==after.branch||before.changeset!==after.changeset||before.repository!==after.repository)throw new Error('Workspace selector changed during read-only inspection');
 const result={checkedAt:new Date().toISOString(),repository:before.repository,changeset,workspaceSelectorUnchanged:true,files:verified,scope:'Cloud file retrieval only; not Unity execution or visual approval'};
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(result,null,2));return result;
}
export async function stageNewDeliverables(client,workspace){
 const files=[];
 for(const name of ['Assets','ProjectDocs']){
  const root=path.join(workspace,name);if(!fs.existsSync(root))continue;
  const result=await client.execCm(['status',root,'--private','--short','--fullpaths'],workspace);
  for(const line of result.stdout.split(/\r?\n/)){
   const candidate=line.trim().replace(/^"|"$/g,'');if(!candidate)continue;
   const absolute=path.resolve(workspace,candidate),relative=path.relative(workspace,absolute).split(path.sep).join('/');
   safeDeliveryPath(relative);
   if(!fs.existsSync(absolute)||!fs.lstatSync(absolute).isFile())continue;
   const real=path.relative(fs.realpathSync(workspace),fs.realpathSync(absolute));if(real.startsWith('..')||path.isAbsolute(real))throw new Error('Delivery file escapes task workspace');
   if(!/\.(cs|meta|unity|prefab|asset|mat|shader|hlsl|cginc|asmdef|asmref|json|md|txt|wav|ogg|mp3|fbx|blend|png|jpg|jpeg|tga|svg)$/i.test(relative)||/\.log$/i.test(relative))continue;
   files.push(relative);
  }
 }
 const unique=[...new Set(files)];
 if(unique.length>1000)throw new Error('Too many new delivery files; explicit review required');
 // Add only intended project directories, never root logs, caches or profile credentials.
 for(let i=0;i<unique.length;i+=32)await client.execCm(['add',...unique.slice(i,i+32)],workspace);
 return unique;
}
export function bindInboxEvidence(SessionBridge,provider){
 const deliver=SessionBridge.prototype.deliver;
 SessionBridge.prototype.deliver=async function(prompt,signal){
  let evidence;try{evidence=await provider(prompt);}catch(error){evidence={checkedAt:new Date().toISOString(),inspectionFailed:true,reason:String(error.message).slice(0,600)};}
  return deliver.call(this,[
   'Verified parent-Worker evidence follows. The inbox cwd is not evidence that no formal Worker exists. Do not answer "only an inbox" without checking this evidence.',
   'Read-only inspection of the explicitly supplied baseline/task roots and delivery caches is authorized. Do not edit them or switch the inbox branch. A cs:9 inbox does not describe cloud cs:11 or the latest repository history.',
   'For a status/review question, inspect the supplied evidence/cache files using tools before replying. Report actual commands/results. If a query fails, state the real error, not an untested claim that files or permissions are unavailable.',
   JSON.stringify({parentWorkerEvidence:evidence}),prompt,
  ].join('\n'),signal);
 };
}
export async function runtimeEvidence(runner,cfg,profile){
 const status=await runner.uvcs.getStatus(cfg.workspaceDir);
 let version;try{const result=await promisify(execFile)(cfg.unityEditor,['-version'],{windowsHide:true,timeout:30000,maxBuffer:65536});version=result.stdout.trim();}catch(error){version='Version query failed: '+String(error.message).slice(0,200);}
 const evidence={checkedAt:new Date().toISOString(),hostname:os.hostname(),agentId:cfg.agentId,workerId:runner.workerId,workerPid:process.pid,formalWorkerRunning:runner.running===true,currentRunId:runner.currentRunId||null,baselineWorkspace:cfg.workspaceDir,baseline:status,taskWorkspaceRoot:cfg.taskWorkspaceRoot,cmBinary:cfg.cmBinary,unityExecutable:cfg.unityEditor,unityVersion:version,progressPeerAgent:cfg.progressPeerAgent,newFileStagingHook:cfg.newFileStagingEnabled===true,leaseAndFailureReporting:'Parent Worker guards active leases and reports failed runs; this receipt is not a new business-task execution test',baselinePolicy:'Do not claim that a newer integration baseline is loaded unless the selector above proves it'};
 fs.writeFileSync(path.join(profile,'execution-evidence.json'),JSON.stringify(evidence,null,2));return evidence;
}
