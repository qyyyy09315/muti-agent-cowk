import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {readJson,readLocal,redact,inspectSessions,allowedRequest,discoverProfile} from './core.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
function option(key,fallback){const i=args.indexOf(key);return i<0?fallback:args[i+1];}
const profile=discoverProfile(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),option('--profile',process.env.AI_COLLAB_PROFILE));
const requestedPort=Number(option('--port','8787'));
if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535)throw new Error('Invalid port');
let remote={checkedAt:null,hubOk:false,hubError:'首次采集中',processes:[],tasks:[],workers:[],messages:[],events:[],errors:[]};
let previous=null,events=[],collecting=false,collector,sessionCache=[],lastSessions=0,port=requestedPort;
function collect(){
 if(collecting)return;
 collecting=true;
 const env={...process.env};delete env.PSModulePath;
 const powershell=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 collector=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'collect.ps1'),'-ProfileDir',profile,'-AfterEvent',String(Math.max(0,...events.map(e=>Number(e.id)||0)))],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='',error=''; let finished=false;
 const finish=(failure)=>{
  if(finished)return;finished=true;clearTimeout(timer);collecting=false;
  if(failure){previous=remote;remote={...remote,hubOk:false,hubError:failure,failedAt:new Date().toISOString()};return;}
  try{
   const value=JSON.parse(output.replace(/^\uFEFF/,''));
   events=[...new Map([...events,...(value.events||[])].map(e=>[e.id,e])).values()].sort((a,b)=>a.id-b.id).slice(-120);
   previous=remote;
   remote={...value,events};
  }catch{remote={...remote,hubOk:false,hubError:'采集器输出无法解析',failedAt:new Date().toISOString()};}
 };
 const timer=setTimeout(()=>{collector.kill();finish('采集超时，显示上次快照');},25000);
 collector.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>2000000){collector.kill();finish('快照超过大小限制');}});
 collector.stderr.on('data',b=>{error=(error+b.toString('utf8')).slice(-500);});
 collector.on('error',()=>finish('无法启动PowerShell采集器'));
 collector.on('close',code=>finish(code===0?null:'采集器退出失败：'+redact(error)));
}
function snapshot(){
 const local=readLocal(profile),cfg=readJson(path.join(profile,'worker-config.json'),{});
 if(Date.now()-lastSessions>7000){sessionCache=inspectSessions(profile,cfg);lastSessions=Date.now();}
 const own=(remote.workers||[]).find(w=>w.id===local.identity.workerId);
 const processes=remote.processes||[];
 const roots=processes.filter(p=>p.kind==='Worker');
 const active=processes.filter(p=>/CLI/.test(p.kind));
 return redact({service:'ai-collab-local-monitor',schemaVersion:1,now:new Date().toISOString(),refreshMs:2000,readOnly:true,collecting,
  local,remote,processCount:roots.length,cli:{active,mode:active.length?'正在处理':roots.length?'空闲 / 等待消息或任务':'Worker未运行'},
  ownWorker:own||null,sessions:sessionCache,previousCollectedAt:previous?.checkedAt||null});
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
 if(!allowedRequest(req,port)){res.writeHead(403);return res.end('Local access only');}
 if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});return res.end('Read only');}
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/api/snapshot'){
  try {const body=JSON.stringify(snapshot());res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(body);}
  catch {res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'本机快照读取失败，请稍后重试'}));}
 }
 const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
 if(!files[url.pathname]){res.writeHead(404);return res.end('Not found');}
 const file=path.join(here,'public',files[url.pathname]);res.writeHead(200,{'Content-Type':types[path.extname(file)]});fs.createReadStream(file).pipe(res);
});
server.listen(requestedPort,'127.0.0.1',()=>{
 port=server.address().port;
 const info={url:`http://127.0.0.1:${port}`,port,pid:process.pid,profile,startedAt:new Date().toISOString()};
 try{fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'monitor-process.json'),JSON.stringify(info,null,2));}catch{}
 console.log(JSON.stringify(info));collect();
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'监视端口已占用；请使用已有页面或更换 --port':e.message);process.exit(1);});
const interval=setInterval(collect,5000);
function stop(){clearInterval(interval);collector?.kill();server.close(()=>process.exit(0));}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
