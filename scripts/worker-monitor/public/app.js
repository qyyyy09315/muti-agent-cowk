const $=id=>document.getElementById(id);
let snapshot=null,paused=false,busy=false,tab='session',terminalText='',lastMessages='',lastTasks='';
function time(value,full=false){if(!value)return '未取得';const d=new Date(value);return Number.isNaN(d.getTime())?'时间未知':d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',...(full?{}:{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}),hour12:false});}
function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function metric(id,text,tone=''){const el=$(id);el.textContent=text;el.className='metric-value '+tone;}
function age(value){if(!value)return '未取得心跳';const seconds=Math.round((Date.now()-new Date(value).getTime())/1000);return seconds<0?'心跳时间存在时钟偏差':seconds+' 秒前心跳';}
function renderAlerts(data){
 const alerts=[];
 if(!data.local.configured)alerts.push('未找到有效 Worker 配置。请用启动脚本的 -ProfileDir 参数指定实际运行目录。');
 alerts.push(...data.local.logs.warnings);
 if(!data.remote.hubOk)alerts.push('Hub 读取受阻：'+(data.remote.hubError||'等待连接')+'。本机日志仍可查看。');
 const collected=data.remote.checkedAt;
 if(collected && Date.now()-new Date(collected).getTime()>20000)alerts.push('采集数据超过 20 秒未更新，下面可能是旧快照。');
 if(data.processCount>1)alerts.push('检测到多个 Worker 实例，请核对 PID；本页不会自动停止任何实例。');
 if(data.ownWorker?.status==='online' && data.processCount===0 && collected)alerts.push('Hub 仍显示在线，但本机未发现 Worker 进程；请结合快照时间核对。');
 alerts.push(...(data.remote.errors||[]));
 for(const task of data.remote.tasks||[]){if(task.currentAttempt>=3&&['leased','running','queued'].includes(task.state))alerts.push('任务“'+task.title+'”已领取 '+task.currentAttempt+' 次，可能反复重试；请查看任务 CLI 和错误日志。');}
 $('alerts').replaceChildren(...alerts.map(t=>node('div','alert',t)));
}
function renderMessages(){
 const messages=(snapshot.remote.messages||[]).flat().filter(m=>m&&m.content).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
 $('message-count').textContent=messages.length;
 const filter=$('message-filter').value;
 const list=messages.filter(m=>filter==='all'||(filter==='in'?m.toAgent===(snapshot.local.identity.agentType||'codex'):m.fromAgent===(snapshot.local.identity.agentType||'codex')));
 const key=JSON.stringify([filter,list]);if(key===lastMessages)return;lastMessages=key;
 const box=$('messages'),nearBottom=box.scrollTop+box.clientHeight>=box.scrollHeight-60;
 const items=list.slice(-60).map(m=>{
  const out=m.fromAgent===(snapshot.local.identity.agentType||'codex'),el=node('article','message'+(out?' out':''));
  const meta=node('div','message-meta');
  meta.append(node('span','message-author',out?'本机 '+m.fromAgent+' → '+m.toAgent:'协作者 '+m.fromAgent+' → '+m.toAgent),node('time','',time(m.createdAt)));
  el.append(meta,node('p','message-content',m.content),node('div','message-context',(m.replyToId?'回复 · ':'新消息 · ')+m.taskId));return el;
 });
 box.replaceChildren(...(items.length?items:[node('div','empty',snapshot.remote.hubOk?'该筛选下暂无消息':'Hub 连接恢复后可读取消息')]));
 if(nearBottom&&$('autoscroll').checked)box.scrollTop=box.scrollHeight;
}
const stateNames={queued:'排队',leased:'已领取',running:'执行中',waiting_peer:'等待协作者',waiting_human:'等待人工',submitted:'已交付',completed:'已完成',approved:'已批准',failed:'失败',cancelled:'已取消',paused:'已暂停'};
function renderTasks(){
 const tasks=(snapshot.remote.tasks||[]).flat().filter(Boolean).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
 $('task-count').textContent=tasks.length;
 const key=JSON.stringify(tasks);if(key!==lastTasks){lastTasks=key;
  $('tasks').replaceChildren(...(tasks.length?tasks.slice(0,12).map(t=>{
   const row=node('article','task'),head=node('div','task-heading');
   const tone=['failed','cancelled'].includes(t.state)?'bad':['running','leased','queued'].includes(t.state)?'':'warn';
   head.append(node('div','task-title',t.title),node('span','badge '+tone,stateNames[t.state]||t.state));
   row.append(head,node('div','task-meta',(t.assignedAgent||'未分派')+' · '+t.id),node('div','task-meta','第 '+(t.currentAttempt||0)+' 次领取 · 更新于 '+time(t.updatedAt)));return row;
  }):[node('div','empty','暂无任务快照')]));
 }
 const processes=snapshot.remote.processes||[];
 $('processes').replaceChildren(...(processes.length?processes.map(p=>{const row=node('div','process-row');row.append(node('span','',p.kind+' · '+p.name),node('span','','PID '+p.pid+' ← '+p.parentPid));return row;}):[node('div','metric-detail','未发现 Worker 进程，或进程采集尚未完成')]));
 $('phase').textContent=snapshot.local.phase?'日志最后阶段（不代表仍在执行）：'+snapshot.local.phase:'暂无流水线阶段记录';
}
function sessionText(){
 const sessions=snapshot.sessions||[];
 if(!sessions.length)return '尚未发现此 Worker 的 CLI 会话记录。\n\n这里只读取专属收件目录或任务工作目录的会话，不显示其他桌面聊天。CLI 启动后可在此查看已记录的公开对话；不会显示内部推理。';
 return sessions.map(s=>[
  '━━ '+s.kind+' ━━',
  '会话 '+s.sessionId+' · 最后写入 '+time(s.updatedAt),
  '目录 '+s.cwd,'',
  ...(s.turns||[]).flatMap(t=>['['+time(t.at)+'] '+(t.role==='assistant'?'CLI 回复':'输入上下文'),t.text,'']),
 ].join('\n')).join('\n\n');
}
function renderTerminal(){
 if(!snapshot)return;
 const logs=snapshot.local.logs;
 const content={session:sessionText(),stdout:logs.stdoutLines.join('\n')||'暂无 Worker 日志。启动记录缺失时会自动查找最新日志。',stderr:logs.stderrLines.join('\n')||'当前选中错误日志为空。网络重试也可能记录在 Worker 日志中。',events:(snapshot.remote.events||[]).map(e=>'['+time(e.createdAt)+'] #'+e.id+' '+e.type+'\n'+JSON.stringify(e.payload,null,2)).join('\n\n')||'尚无 Hub 事件快照。'}[tab];
 const filter=$('log-filter').value.trim().toLowerCase();terminalText=filter?content.split('\n').filter(l=>l.toLowerCase().includes(filter)).join('\n'):content;
 const terminal=$('terminal');if(terminal.textContent!==terminalText){terminal.textContent=terminalText||'没有匹配的内容';if($('autoscroll').checked)terminal.scrollTop=terminal.scrollHeight;}
 $('terminal-description').textContent={session:'最近两天内、此 Worker 专属的 CLI 公开对话（限量读取）',stdout:'最新 240 行 · 含消息收发、任务阶段及网络重试',stderr:'最新 100 行 · 标准错误输出',events:'本次监视服务已采集的最近 120 个 Hub 事件'}[tab];
 $('terminal-source').textContent={session:'后台 CLI 会话与当前桌面聊天相互独立。没有新输出时不会生成模拟内容。',stdout:logs.stdout||'日志路径未找到',stderr:logs.stderr||'错误日志路径未找到',events:'采集于 '+time(snapshot.remote.checkedAt,true)}[tab];
}
function renderDetails(data){
 const identity=data.local.identity;
 const project=document.querySelector('.project-name');project.replaceChildren(document.createTextNode(identity.projectName||identity.projectId||'尚未配置'),node('span','',(identity.username||'未取得用户')+' / '+(identity.hostname||'本机')));
 const entries=[['运行目录',data.local.profile],['目录来源',data.local.logs.source],['Worker ID',identity.workerId],['项目 ID',identity.projectId],['Hub',identity.hub],['代码版本',identity.sourceCommit],['任务基准',identity.workspace],['消息模型',identity.messageModel],['本机采集',time(data.remote.checkedAt,true)],['日志最后写入',time(data.local.logs.updatedAt,true)]];
 $('connection-details').replaceChildren(...entries.flatMap(([label,value])=>[node('dt','',label),node('dd','',value||'未取得')]));
}
function render(data){
 snapshot=data;renderAlerts(data);
 const root=data.processCount>0,online=data.ownWorker?.status==='online';
 metric('worker-status',!data.remote.checkedAt?'采集中':root?(online?'运行 / 在线':'本机运行中'):'未发现进程',!data.remote.checkedAt?'':root&&online?'good':root?'warn':'bad');
 $('worker-detail').textContent='Hub: '+(data.ownWorker?.status||'未知')+' · '+age(data.ownWorker?.lastHeartbeatAt);
 metric('cli-status',data.remote.checkedAt?data.cli.mode:'采集中',data.cli.active.length?'good':'');
 $('cli-detail').textContent=data.cli.active.length?data.cli.active.map(p=>p.kind+' / PID '+p.pid).join(' · '):'空闲不代表离线；等待时没有模型子进程';
 const pending=data.local.inbox.some(i=>i.pendingReply),cursor=Math.max(0,...data.local.inbox.map(i=>Number(i.cursor)||0));
 metric('inbox-status',pending?'回复待发送':data.local.listenerSeen&&root?'监听已启动':'待核验',pending?'warn':root&&data.local.listenerSeen?'good':'');
 $('inbox-detail').textContent='游标 '+cursor+' · '+(data.local.lastReplied?'已发现自动回复记录':'等待下一条消息')+'（不等于网络始终畅通）';
 metric('hub-status',data.remote.hubOk?'连接正常':'读取受阻',data.remote.hubOk?'good':'warn');
 $('hub-detail').textContent='最近采集 '+time(data.remote.checkedAt);
 $('refresh-state').textContent=(paused?'刷新已暂停':'每 2 秒刷新')+' · '+time(data.now);
 $('footer-time').textContent='显示时间：北京时间';
 renderMessages();renderTasks();renderTerminal();renderDetails(data);
}
async function poll(force=false){
 if(busy||(paused&&!force))return;busy=true;$('refresh').disabled=true;
 try{const response=await fetch('/api/snapshot',{signal:AbortSignal.timeout(6000)});if(!response.ok)throw new Error('HTTP '+response.status);render(await response.json());}
 catch{ $('refresh-state').textContent='本机监视服务连接中断';$('alerts').replaceChildren(node('div','alert error','无法连接本机监视服务。下面保留的是旧快照，请重新运行 start_worker_monitor.ps1。'));}
 finally{busy=false;$('refresh').disabled=false;}
}
$('refresh').onclick=()=>poll(true);
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'恢复刷新':'暂停刷新';if(snapshot)render(snapshot);if(!paused)poll(true);};
$('message-filter').onchange=()=>{if(snapshot)renderMessages();};
$('log-filter').oninput=renderTerminal;
document.querySelectorAll('[data-tab]').forEach(button=>{button.onclick=()=>{tab=button.dataset.tab;document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===button)));renderTerminal();};button.onkeydown=e=>{if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft')return;const tabs=[...document.querySelectorAll('[data-tab]')],index=tabs.indexOf(button),next=tabs[(index+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.focus();next.click();};});
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(terminalText);$('copy').textContent='已复制';}catch{$('copy').textContent='复制失败，请选中文本';}setTimeout(()=>{$('copy').textContent='复制当前内容';},1800);};
poll();setInterval(()=>poll(),2000);
