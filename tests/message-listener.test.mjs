import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { buildServer } from '../apps/hub/dist/src/server.js';
import { MemoryStorageEngine } from '../apps/hub/dist/src/db.js';
import { HubClient } from '../apps/worker/dist/src/client.js';
import { WorkerRunner } from '../apps/worker/dist/src/runner.js';
import { MessageListener } from '../apps/worker/dist/src/message-listener.js';

test('messages-only Worker automatically responds over real Hub HTTP; peer receives reply without a loop', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-message-e2e-'));
  const fakeCli = path.join(directory, 'codex.cjs');
  fs.writeFileSync(fakeCli, `
    const fs = require('node:fs');
    let input = '';
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      if (!input.includes('端 B 你好')) process.exit(2);
      const args = process.argv;
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '端 B 已收到');
    });
  `);
  const previousBinary = process.env.CODEX_BIN;
  process.env.CODEX_BIN = fakeCli;
  const app = await buildServer({ storage: new MemoryStorageEngine() });
  let runner, workerLoop, peerLoop;
  const peerAbort = new AbortController();
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const project = await app.inject({ method: 'POST', url: '/api/projects', payload: {
      id: 'chat_project', name: 'Chat only', uvcsRepo: 'unused',
    } });
    assert.equal(project.statusCode, 201);
    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: {
      projectId: 'chat_project', title: 'Connectivity', goal: 'Reply only', acceptanceCriteria: 'Received', assignedAgent: 'grok',
    } });
    const task = response.json();
    assert.equal(response.statusCode, 201);
    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/actions`, payload: { action: 'pause' } });
    const client = new HubClient(url);
    const received = [];
    let unexpectedReplies = 0;
    const peer = new MessageListener(client, { async reply() { unexpectedReplies++; return 'loop'; } },
      'chat_project', 'grok', path.join(directory, 'peer.json'), line => received.push(line));
    peerLoop = peer.run(peerAbort.signal, 20);
    runner = new WorkerRunner({ hubUrl: url, projectId: 'chat_project', agentType: 'codex',
      workspaceDir: directory, workerId: 'test_codex', messagesOnly: true,
      messageStateDir: path.join(directory, 'worker-inbox') });
    runner.checkRemoteVersionNonBlocking = () => {}; // Keep this offline integration test local.
    let claims = 0;
    runner.client.claimRun = async () => { claims++; throw new Error('must not claim tasks in chat mode'); };
    workerLoop = runner.start();
    await client.sendMessage({ projectId: 'chat_project', taskId: task.id, threadId: 'conversation',
      fromAgent: 'grok', toAgent: 'codex', content: '端 B 你好', idempotencyKey: 'hello' });
    const deadline = Date.now() + 10000;
    while (!received.some(line => line.includes('端 B 已收到')) && Date.now() < deadline) await delay(50);
    assert.ok(received.some(line => line.includes('端 B 已收到')), 'peer listener receives the automatic reply');
    const messages = await client.listMessages(task.id, 'conversation');
    assert.equal(messages.length, 2);
    assert.equal(messages[1].replyToId, messages[0].id);
    assert.equal(messages[1].fromAgent, 'codex');
    assert.equal(unexpectedReplies, 0);
    assert.equal(claims, 0);
    assert.equal(fs.existsSync(path.join(directory, 'Assets')), false);
  } finally {
    peerAbort.abort();
    await runner?.stop();
    await Promise.all([workerLoop, peerLoop]);
    await app.close();
    if (previousBinary === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousBinary;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
