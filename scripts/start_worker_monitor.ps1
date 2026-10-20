param([string]$ProfileDir='', [ValidateRange(1024,65535)][int]$Port=8787, [switch]$NoOpen)
$ErrorActionPreference='Stop'
if(-not $ProfileDir){
 if($env:AI_COLLAB_PROFILE){$ProfileDir=$env:AI_COLLAB_PROFILE}else{
  $profileRoot=Join-Path $env:LOCALAPPDATA 'AI-Collab'
  $profiles=@(Get-ChildItem -LiteralPath $profileRoot -Directory -ErrorAction SilentlyContinue|Where-Object {Test-Path -LiteralPath (Join-Path $_.FullName 'worker-config.json')})
  if($profiles.Count -gt 1){throw '找到多个Worker配置，请使用 -ProfileDir 指定运行目录。'}
  if($profiles.Count -eq 1){$ProfileDir=$profiles[0].FullName}else{$ProfileDir=Join-Path $profileRoot $env:USERNAME}
 }
}
$ProfileDir=[IO.Path]::GetFullPath($ProfileDir)
$url="http://127.0.0.1:$Port"
$running=$false
try{$health=Invoke-RestMethod "$url/api/snapshot" -TimeoutSec 2;$running=$health.service -eq 'ai-collab-local-monitor' -and $health.local.profile -eq $ProfileDir}catch{}
if(-not $running){
 New-Item -ItemType Directory -Path $ProfileDir -Force|Out-Null
 $node=(Get-Command node.exe -ErrorAction Stop).Source
 $entry=Join-Path $PSScriptRoot 'worker-monitor/server.mjs'
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
 $outFile=Join-Path $ProfileDir "monitor-$stamp.stdout.log"
 $errFile=Join-Path $ProfileDir "monitor-$stamp.stderr.log"
 $process=Start-Process -FilePath $node -ArgumentList @(('"'+$entry+'"'),'--profile',('"'+$ProfileDir+'"'),'--port',"$Port") -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
 $ready=$false
 for($i=0;$i -lt 20;$i++){
  if($process.HasExited){throw ('监视服务启动失败，请查看 '+$errFile)}
  try{$health=Invoke-RestMethod "$url/api/snapshot" -TimeoutSec 1;if($health.service -eq 'ai-collab-local-monitor' -and $health.local.profile -eq $ProfileDir){$ready=$true;break}}catch{}
  Start-Sleep -Milliseconds 250
 }
 if(-not $ready){throw '监视服务未就绪；请检查端口是否被占用，或用 -Port 更换端口。'}
}
Write-Output "监视地址：$url"
Write-Output "运行目录：$ProfileDir"
if(-not $NoOpen){Start-Process $url -WindowStyle Hidden}
