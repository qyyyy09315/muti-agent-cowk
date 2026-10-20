import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
export function discoverProfile(localRoot, explicit) {
  if(explicit)return path.resolve(explicit);
  const root=path.join(localRoot,'AI-Collab');
  let profiles=[];
  try{profiles=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync(path.join(root,e.name,'worker-config.json'))).map(e=>path.join(root,e.name));}catch{}
  if(profiles.length>1)throw new Error('Multiple Worker profiles found; pass --profile <directory>');
  return profiles[0]||path.join(root,process.env.USERNAME||os.userInfo().username);
}
export function redact(value) {
  if (typeof value === 'string') return value
    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[已隐藏]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/(["']?(?:password|passwd|api[_-]?key|(?:hub[_-]?|access[_-]?|refresh[_-]?)?token|authorization)["']?\s*[=:]\s*["']?)[^\s,"'&}]+/gi, '$1[已隐藏]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:password|passwd|token|secret|authorization|api[_-]?key|credential)/i.test(key)).map(([key, v]) => [key, redact(v)]));
  return value;
}
export function tail(file, bytes = 65536) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      return start ? text.slice(text.indexOf('\n') + 1) : text;
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}
function inside(file, root) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
export function chooseLogs(profile) {
  const meta = readJson(path.join(profile, 'worker-process.json'));
  const warnings = [];
  const safe = file => typeof file === 'string' && inside(file, profile) && file.endsWith('.log') && fs.existsSync(file);
  let stdout = safe(meta?.stdout) ? meta.stdout : null;
  if (!stdout) {
    warnings.push('启动记录缺失或失效，已尝试查找最新 stdout 日志。');
    try { stdout = fs.readdirSync(profile).filter(n => /^worker-.*\.stdout\.log$/.test(n)).map(n => path.join(profile, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null; } catch {}
  }
  const stderr = stdout ? stdout.replace(/\.stdout\.log$/, '.stderr.log') : null;
  return { stdout, stderr: safe(stderr) ? stderr : null, source: meta && stdout === meta.stdout ? '启动记录' : '最新日志回退', warnings };
}
export function readLocal(profile) {
  const cfg = readJson(path.join(profile, 'worker-config.json'), {});
  const logs = chooseLogs(profile);
  const out = tail(logs.stdout).split(/\r?\n/).filter(Boolean).slice(-240);
  const err = tail(logs.stderr).split(/\r?\n/).filter(Boolean).slice(-100);
  let inbox = [];
  try { inbox = fs.readdirSync(path.join(profile, 'inbox')).filter(n => n.endsWith('.json')).map(n => ({ name: n, ...readJson(path.join(profile, 'inbox', n), {}), updatedAt: fs.statSync(path.join(profile, 'inbox', n)).mtime.toISOString() })); } catch {}
  const phases = out.filter(line => /\[Pipeline |成功抢单|任务交付|流程中断/.test(line));
  return {
    profile, profileExists: fs.existsSync(profile), configured: Boolean(cfg.hubUrl && cfg.projectId),
    identity: { username: cfg.username, hostname: os.hostname(), agentType: cfg.agentType||'codex', workerId: cfg.workerId, projectId: cfg.projectId, projectName: cfg.projectName, hub: cfg.hubUrl, sourceCommit: cfg.sourceCommit, workspace: cfg.workspaceDir, taskWorkspaceRoot: cfg.taskWorkspaceRoot, messageModel: cfg.messageModel },
    logs: { ...logs, stdoutLines: out, stderrLines: err, updatedAt: logs.stdout ? fs.statSync(logs.stdout).mtime.toISOString() : null },
    inbox: inbox.map(({name, cursor, pending, updatedAt}) => ({name, cursor, pendingReply: Boolean(pending), pendingMessageId: pending?.message?.replyToId || null, updatedAt})),
    listenerSeen: out.some(l => l.includes('[Messages]: listening')), phase: phases.at(-1) || null,
    lastReceived: out.filter(l => l.includes('[Message received]')).at(-1) || null,
    lastReplied: out.filter(l => l.includes('[Message replied]')).at(-1) || null,
  };
}
export function inspectSessions(profile, cfg = {}, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  // Restrict reads to sessions explicitly belonging to this Worker's inbox/task cwd.
  const inbox = path.join(profile, 'message-session');
  const dates = [new Date(), new Date(Date.now() - 86400000)];
  const files = [];
  for (const date of dates) {
    const directory = path.join(home, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    try { files.push(...fs.readdirSync(directory).filter(n => n.endsWith('.jsonl')).map(n => path.join(directory, n))); } catch {}
  }
  const result = [];
  for (const file of files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 80)) {
    let first;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const b = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 1024 * 1024));
        const n = fs.readSync(fd, b, 0, b.length, 0);
        first = JSON.parse(b.subarray(0, n).toString('utf8').split('\n')[0]);
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    if (first.type !== 'session_meta' || !first.payload?.cwd) continue;
    const cwd = first.payload.cwd;
    const kind = path.resolve(cwd).toLowerCase() === path.resolve(inbox).toLowerCase() ? '收件 CLI' : cfg.taskWorkspaceRoot && inside(cwd, cfg.taskWorkspaceRoot) ? '任务 CLI' : null;
    if (!kind || result.some(s => s.kind === kind)) continue;
    const turns = [];
    for (const line of tail(file, 100000).split('\n')) {
      try {
        const row = JSON.parse(line); const p = row.payload;
        if (row.type === 'response_item' && p?.type === 'message' && p.channel !== 'analysis' && ['assistant', 'user'].includes(p.role)) {
          const text = (p.content || []).filter(c => c.type === 'input_text' || c.type === 'output_text').map(c => c.text || '').join('\n');
          if (text) turns.push({ role: p.role, text: text.slice(-4000), at: row.timestamp });
        }
      } catch {}
    }
    result.push({ kind, sessionId: first.payload.id, cwd, updatedAt: fs.statSync(file).mtime.toISOString(), turns: turns.slice(-6) });
  }
  return result;
}
export function allowedRequest(req, port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(req.headers.host)) return false;
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
