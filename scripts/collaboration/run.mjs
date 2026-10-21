import fs from 'node:fs';
import path from 'node:path';
import {WorkerRunner} from '../../apps/worker/dist/src/runner.js';
import {MessageListener} from '../../apps/worker/dist/src/message-listener.js';
import {SessionBridge} from '../../apps/worker/dist/src/session-bridge.js';
import {installCollaborationRuntime} from './install.mjs';

const args=process.argv.slice(2),index=args.indexOf('--profile');
if(index<0||!args[index+1])throw new Error('Usage: node scripts/collaboration/run.mjs --profile <directory containing worker-config.json>');
const profileDir=path.resolve(args[index+1]);
const cfg=JSON.parse(fs.readFileSync(path.join(profileDir,'worker-config.json'),'utf8').replace(/^\uFEFF/,''));
for(const key of ['hubUrl','projectId','agentId','workspaceDir','taskWorkspaceRoot'])if(!cfg[key])throw new Error('Missing configuration: '+key);
if(cfg.adapter&&cfg.adapter!=='codex')throw new Error('This optional launcher currently supports Codex adapters; use the standard Worker launcher for Grok');
if(cfg.automaticPeerRoutingEnabled&&!process.env.HUB_CONTROL_TOKEN)throw new Error('Routing verifier requires HUB_CONTROL_TOKEN in the parent process');
const agentCredential=process.env.HUB_TOKEN,controlCredential=process.env.HUB_CONTROL_TOKEN;
if(!agentCredential)throw new Error('Set an Agent-bound HUB_TOKEN before launching');
delete process.env.HUB_TOKEN;delete process.env.HUB_CONTROL_TOKEN;
const runner=new WorkerRunner({hubUrl:cfg.hubUrl,projectId:cfg.projectId,agentType:cfg.agentId,workerId:cfg.workerId,workspaceDir:cfg.workspaceDir,taskWorkspaceBaseDir:cfg.taskWorkspaceRoot,cmBinary:cfg.cmBinary,token:agentCredential,listenMessages:true,messageStateDir:path.join(profileDir,'inbox')});
const verifyPeer=async agentId=>{
 const res=await fetch(cfg.hubUrl.replace(/\/$/,'')+'/api/workers',{headers:{Authorization:'Bearer '+controlCredential},signal:AbortSignal.timeout(15000)});
 if(!res.ok)throw new Error('Peer registry unavailable');
 const worker=(await res.json()).find(w=>w.agentType===agentId&&w.status==='online');
 return worker?{verified:true,agentId,workerId:worker.id,lastHeartbeatAt:worker.lastHeartbeatAt}:null;
};
await installCollaborationRuntime(runner,cfg,{profileDir,MessageListener,SessionBridge,verifyPeer});
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await runner.stop();process.exit(0);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
await runner.start();
