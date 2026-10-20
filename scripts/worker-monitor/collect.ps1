param([Parameter(Mandatory=$true)][string]$ProfileDir,[long]$AfterEvent=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$result=[ordered]@{checkedAt=[DateTimeOffset]::Now.ToString('o');hubOk=$false;hubError=$null;workers=@();tasks=@();messages=@();events=@();processes=@();processAssociation='unavailable';errors=@()}
$cfg=$null;$meta=$null
try{$cfg=Get-Content -LiteralPath (Join-Path $ProfileDir 'worker-config.json') -Raw|ConvertFrom-Json}catch{}
try{$meta=Get-Content -LiteralPath (Join-Path $ProfileDir 'worker-process.json') -Raw|ConvertFrom-Json}catch{}
try {
 $all=@(Get-CimInstance Win32_Process)
 $candidates=@($all|Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match '(?:ai_collab_worker\.mjs|[\\/]worker[\\/]dist[\\/]src[\\/]index\.js)' -and $_.CommandLine -notmatch 'preflight'})
 $roots=@()
 if($meta){
  $roots=@($candidates|Where-Object {($meta.launcherPid -and $_.ParentProcessId -eq $meta.launcherPid) -or ($meta.nodePid -and $_.ProcessId -eq $meta.nodePid)})
  if($roots.Count){$result.processAssociation='process metadata'}
 }
 if(-not $roots.Count -and $cfg){
  $roots=@($candidates|Where-Object {
   $line=$_.CommandLine.Replace('\','/')
   ($cfg.workerId -and $_.CommandLine -match ('--worker-id[=\s]+["'']?'+[regex]::Escape($cfg.workerId)+'(?:["''\s]|$)')) -or
   ($cfg.workspaceDir -and $line.IndexOf($cfg.workspaceDir.Replace('\','/'),[StringComparison]::OrdinalIgnoreCase) -ge 0)
  })
  if($roots.Count){$result.processAssociation='command identity'}
 }
 $ids=@($roots|ForEach-Object {$_.ProcessId})
 for($i=0;$i -lt 5;$i++){$ids=@($ids)+@($all|Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids}|ForEach-Object {$_.ProcessId})}
 $result.processes=@($all|Where-Object {$_.ProcessId -in $ids}|ForEach-Object {
  $kind=if($_.ProcessId -in @($roots|ForEach-Object {$_.ProcessId})){'Worker'}elseif($_.Name -match 'codex|grok') {if($_.CommandLine -match 'message-session|ai-collab-session-'){'收件 CLI'}else{'任务 CLI'}}elseif($_.Name -match '^cm'){'UVCS'}elseif($_.Name -match '^Unity'){'Unity'}else{'子进程'}
  [ordered]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;kind=$kind;startedAt=$_.CreationDate.ToString('o')}
 })
}catch{$result.errors+=('进程采集失败：'+$_.Exception.Message)}
try {
 if(-not $cfg){throw 'worker-config.json不存在或无法解析，请指定 -ProfileDir'}
 $hub=[Uri]$cfg.hubUrl
 if(-not $hub.IsAbsoluteUri -or $hub.UserInfo -or ($hub.Scheme -ne 'https' -and -not ($hub.Scheme -eq 'http' -and $hub.IsLoopback))){throw 'Hub必须使用HTTPS，或本机回环HTTP；地址不能包含凭据'}
 if(-not $cfg.projectId){throw '配置缺少projectId'}
 $token=$env:HUB_TOKEN
 if(-not $token){
  $secure=(Get-Content -LiteralPath (Join-Path $ProfileDir 'hub-token.dpapi') -Raw).Trim()|ConvertTo-SecureString
  $token=[System.Net.NetworkCredential]::new('',$secure).Password
 }
 $headers=@{Authorization=('Bearer '+$token)}
 $base=$cfg.hubUrl.TrimEnd('/')
 $denied=$false
 try{
  $workers=Invoke-RestMethod ($base+'/api/workers') -Headers $headers -TimeoutSec 4 -MaximumRedirection 0
  $result.workers=@($workers|ForEach-Object {[ordered]@{id=$_.id;agentType=$_.agentType;hostname=$_.hostname;status=$_.status;lastHeartbeatAt=$_.lastHeartbeatAt;version=$_.version}})
  $result.hubOk=$true
 }catch{
  $code=$_.Exception.Response.StatusCode.value__
  if($code -eq 401 -or $code -eq 403){$denied=$true}else{$result.hubError=$_.Exception.Message}
 }
 try{$tasks=Invoke-RestMethod ($base+'/api/projects/'+[Uri]::EscapeDataString($cfg.projectId)+'/tasks') -Headers $headers -TimeoutSec 4 -MaximumRedirection 0;$result.tasks=@($tasks|ForEach-Object {$_});$result.hubOk=$true}catch{
  $code=$_.Exception.Response.StatusCode.value__
  if($code -eq 401 -or $code -eq 403){$denied=$true}else{$result.errors+=('任务读取失败：'+$_.Exception.Message)}
 }
 try{$events=Invoke-RestMethod ($base+'/api/events?projectId='+[Uri]::EscapeDataString($cfg.projectId)+'&after='+$AfterEvent) -Headers $headers -TimeoutSec 4 -MaximumRedirection 0;$result.events=@($events|ForEach-Object {$_});$result.hubOk=$true}catch{$result.errors+=('事件读取失败：'+$_.Exception.Message)}
 try{
  $messages=Invoke-RestMethod ($base+'/api/projects/'+[Uri]::EscapeDataString($cfg.projectId)+'/messages?limit=100') -Headers $headers -TimeoutSec 4 -MaximumRedirection 0
  $result.messages=@($messages|ForEach-Object {$_})
 }catch{
  if($_.Exception.Response.StatusCode.value__ -eq 404){
   foreach($task in @($result.tasks|Sort-Object updatedAt -Descending|Select-Object -First 12)){
    try{$messages=Invoke-RestMethod ($base+'/api/tasks/'+[Uri]::EscapeDataString($task.id)+'/messages') -Headers $headers -TimeoutSec 3 -MaximumRedirection 0;$result.messages+=@($messages|ForEach-Object {$_})}catch{$result.errors+=('消息读取失败 '+$task.id)}
   }
  }elseif($_.Exception.Response.StatusCode.value__ -eq 401 -or $_.Exception.Response.StatusCode.value__ -eq 403){
   $denied=$true
  }else{$result.errors+=('消息读取失败：'+$_.Exception.Message)}
 }
 if($denied){$result.hubError='令牌权限不足：监视台需要个人令牌（控制台 → 令牌，创建时不要绑定 Agent）。Agent 令牌只能读取事件流。'}
}catch{$result.hubError=$_.Exception.Message}
finally{$token=$null;$headers=$null}
$result|ConvertTo-Json -Depth 18 -Compress
