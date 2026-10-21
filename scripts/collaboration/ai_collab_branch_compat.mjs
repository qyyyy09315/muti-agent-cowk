// Local UVCS bootstrap compatibility: native cm requires parent branches to exist.
import {spawn} from 'node:child_process';
export function execNativeCm(binary,args,cwd){
 return new Promise((resolve,reject)=>{
  const proc=spawn(binary,args,{cwd,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
  let stdout='',stderr='';
  proc.stdout.on('data',d=>{stdout=(stdout+d.toString()).slice(-2097152);});
  proc.stderr.on('data',d=>{stderr=(stderr+d.toString()).slice(-262144);});
  proc.on('error',reject);
  proc.on('close',(code,signal)=>{
   if(code!==0||signal){reject(new Error(`cm ${args[0]} ${args[1]||''} failed: exit=${code}, signal=${signal||'none'}; ${stderr.trim()}`));return;}
   resolve({stdout,stderr,code});
  });
 });
}
export async function ensureTaskBranch(client,workspace,branch,baseChangeset){
 if(!/^br:\/main\/ai\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(branch))throw new Error('Invalid assigned task branch specification');
 if(!/^cs:\d+$/.test(baseChangeset))throw new Error('A pinned native changeset is required');
 const status=await client.getStatus(workspace);
 const parts=branch.slice(3).split('/').filter(Boolean);
 for(let n=2;n<=parts.length;n++){
  const path='/'+parts.slice(0,n).join('/');
  const exists=async()=>{
   const result=await client.execCm(['find','branch',`on repository '${status.repository}'`,'--format={name}','--nototal'],workspace);
   return result.stdout.split(/\r?\n/).some(s=>s.trim()===path);
  };
  if(await exists())continue;
  try{await client.execCm(['branch','create','br:'+path,'--changeset='+baseChangeset,'-c=AI-Collab task namespace bootstrap'],workspace);}
  catch(error){if(!await exists())throw error;}
 }
 return branch;
}
