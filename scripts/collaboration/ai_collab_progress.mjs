// Credential-free helper for an executing CLI. The parent Worker owns Hub access.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const args=process.argv.slice(2),command=args.shift();
const option=(key,fallback)=>{const n=args.indexOf(key);return n<0?fallback:args[n+1];};
const dir=path.resolve(option('--mailbox',path.join(process.cwd(),'.collab_progress')));
if(!fs.existsSync(path.join(dir,'context.json')))throw new Error('Run from the active task workspace with progress enabled');
if(command==='replies'){
 for(const name of fs.readdirSync(path.join(dir,'responses')).filter(n=>n.endsWith('.json')))console.log(fs.readFileSync(path.join(dir,'responses',name),'utf8'));
}else{
 if(!['report','ask'].includes(command))throw new Error('Use report, ask or replies');
 const text=option('--text',''),stage=option('--stage',command==='ask'?'需要协商':'开发节点');
 if(!text||text.length>3000||stage.length>100)throw new Error('Provide --text (1..3000 chars) and --stage (up to 100 chars)');
 const id=randomUUID(),name=id+'.json';
 const request=path.join(dir,'requests',name),temporary=request+'.tmp';
 fs.writeFileSync(temporary,JSON.stringify({type:command,stage,text}));fs.renameSync(temporary,request);
 console.log(JSON.stringify({queued:true,requestId:id}));
 if(command==='ask'){
  const seconds=Math.min(180,Math.max(0,Number(option('--wait-seconds','90'))||0));
  const response=path.join(dir,'responses',name),until=Date.now()+seconds*1000;
  while(Date.now()<until&&!fs.existsSync(response))await delay(1000);
  console.log(fs.existsSync(response)?fs.readFileSync(response,'utf8'):JSON.stringify({waiting:true,requestId:id,next:'Use replies later; do not invent a peer response.'}));
 }
}
