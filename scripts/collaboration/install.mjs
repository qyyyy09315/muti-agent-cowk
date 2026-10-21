import {installTaskExecution,clearDesktopContext} from './ai_collab_task_compat.mjs';
import {bindInboxSession} from './ai_collab_message_compat.mjs';
import {routeProgressReplies,bindInboxProgress} from './ai_collab_progress_bus.mjs';
import {RouteManager,installAutomaticRoutes} from './ai_collab_routes.mjs';
import {execNativeCm,ensureTaskBranch} from './ai_collab_branch_compat.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {bindInboxEvidence,runtimeEvidence,inspectCloudDelivery} from './ai_collab_delivery_evidence.mjs';

/** One Worker per process. Verification is injected; model children never receive control credentials. */
export async function installCollaborationRuntime(runner,cfg,{profileDir,MessageListener,SessionBridge,verifyPeer}={}){
 if(!profileDir)throw new Error('Provide a persistent profileDir');
 if(cfg.automaticPeerRoutingEnabled&&typeof verifyPeer!=='function')throw new Error('Automatic routing requires a read-only peer registry verifier');
 if(cfg.messageEditingEnabled&&(!cfg.messageWorkspaceDir||!cfg.messageBranch||!cfg.unityEditor||!fs.existsSync(path.join(cfg.messageWorkspaceDir,'ProjectSettings','ProjectVersion.txt'))))throw new Error('Editable messages require a dedicated Unity workspace, branch and Unity executable');
 cfg.profileDir=profileDir;
 clearDesktopContext();
 if(cfg.cmBinary){
  runner.uvcs.execCm=(args,cwd)=>execNativeCm(cfg.cmBinary,args[0]==='checkin'&&cfg.newFileStagingEnabled?[...args,'--applychanged']:args,cwd);
  runner.uvcs.createBranch=(workspace,branch,changeset)=>ensureTaskBranch(runner.uvcs,workspace,branch,changeset);
 }
 if(cfg.progressReportingEnabled)routeProgressReplies(MessageListener);
 if(cfg.messageWorkspaceDir){
  if(cfg.messageEditingEnabled){
   const status=await runner.uvcs.getStatus(cfg.messageWorkspaceDir);
   if(!cfg.messageBranch||status.branch!==cfg.messageBranch||!status.branch.startsWith('/main/ai/'))throw new Error('Editable message workspace must be on its configured isolated branch');
  }
  bindInboxSession(SessionBridge,cfg.messageWorkspaceDir,cfg.messageModel,{editable:cfg.messageEditingEnabled===true,branch:cfg.messageBranch,unityEditor:cfg.unityEditor});
 }
 installTaskExecution(runner,cfg);
 if(cfg.messageEditingEnabled&&cfg.progressReportingEnabled)bindInboxProgress(SessionBridge,runner.progressBus,cfg);
 if(cfg.deliveryEvidenceEnabled){
  bindInboxEvidence(SessionBridge,async prompt=>{
   const evidence=await runtimeEvidence(runner,cfg,profileDir);evidence.deliveries=[];evidence.cloudReadErrors=[];
   const registryFile=path.join(profileDir,'delivery-registry.json');
   const registry=fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile,'utf8')):[];
   for(const entry of registry.filter(item=>prompt.includes(item.changeset)).slice(0,3)){
    try{evidence.deliveries.push(await inspectCloudDelivery(runner.uvcs,{workspace:cfg.workspaceDir,changeset:entry.changeset,files:entry.files.map(f=>f.path),cacheRoot:path.join(profileDir,'delivery-cache'),expectedHashes:Object.fromEntries(entry.files.filter(f=>f.sha256).map(f=>[f.path,f.sha256]))}));}
    catch(error){evidence.cloudReadErrors.push({changeset:entry.changeset,error:String(error.message).slice(0,600)});}
   }
   fs.writeFileSync(path.join(profileDir,'execution-evidence.json'),JSON.stringify(evidence,null,2));return evidence;
  });
 }
 let routeTimer;
 if(cfg.automaticPeerRoutingEnabled){
  const manager=new RouteManager(runner.client,cfg,profileDir,{verify:verifyPeer,onChanged:(previous,next)=>runner.progressBus?.acceptSuccessor(previous,next)});
  installAutomaticRoutes(MessageListener,manager);runner.routeManager=manager;
  await manager.bootstrap();
  routeTimer=setInterval(()=>manager.retryPending().catch(()=>console.warn('[Route]: registry verification unavailable; existing route retained')),30000);routeTimer.unref();
 }
 const stop=runner.stop.bind(runner);
 runner.stop=async()=>{clearInterval(routeTimer);clearInterval(runner.progressTimer);await runner.progressBus?.pump();return stop();};
 return runner;
}
