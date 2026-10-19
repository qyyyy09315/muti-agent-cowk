import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MessageSchema, TaskSchema, type Event, type Message, type SendMessageInput } from '@ai-collab/contracts';
import { MessageListener, type MessageResponder } from '../src/message-listener.js';
import { CodexMessageResponder, codexCommand } from '../src/codex-message-responder.js';

const task = TaskSchema.parse({ id: 'task_1', projectId: 'project_1', title: 'Chat', goal: 'Confirm receipt',
  acceptanceCriteria: 'A reply', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
function message(id: string, overrides: Partial<Message> = {}): Message {
  return MessageSchema.parse({ id, projectId: task.projectId, taskId: task.id, threadId: 'thread_1',
    fromAgent: 'grok', toAgent: 'codex', content: '你好，收到请回复', idempotencyKey: id,
    createdAt: new Date().toISOString(), ...overrides });
}
function event(id: number, msg: Message, embedded = true): Event {
  return { id, projectId: msg.projectId, taskId: msg.taskId, runId: null, type: 'message_sent',
    createdAt: msg.createdAt, payload: embedded ? { message: msg } : {
      messageId: msg.id, taskId: msg.taskId, threadId: msg.threadId, from: msg.fromAgent, to: msg.toAgent, content: msg.content,
    } };
}
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-inbox-test-'));
  const stateFile = path.join(directory, 'inbox.json');
  const events: Event[] = [];
  const messages: Message[] = [];
  const sent: SendMessageInput[] = [];
  const log: string[] = [];
  let calls = 0;
  let failSend = false;
  const client = {
    async listEvents(_project: string, after: number) { return events.filter(e => e.id > after).slice(0, 2); },
    async listMessages(taskId: string, threadId: string) { return messages.filter(m => m.taskId === taskId && m.threadId === threadId); },
    async getTask() { return task; },
    async sendMessage(input: SendMessageInput) {
      // Simulate a successful POST whose response is lost, then idempotent delivery on retry.
      if (!sent.some(m => m.idempotencyKey === input.idempotencyKey)) sent.push(input);
      if (failSend) { failSend = false; throw new Error('connection lost after commit'); }
    },
  };
  const responder: MessageResponder = { async reply() { calls++; return '端 B 已收到'; } };
  return { directory, events, messages, sent, log, client, responder,
    listener: () => new MessageListener(client, responder, task.projectId, 'codex', stateFile, line => log.push(line)),
    add(msg: Message, embedded = true) { messages.push(msg); events.push(event(events.length + 1, msg, embedded)); },
    calls: () => calls, failNextSend: () => { failSend = true; },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('replies to root messages from both storage event formats, preserves routing and resumes cursor', async () => {
  const h = harness();
  try {
    h.add(message('one'));
    h.add(message('two'), false);
    await h.listener().pollOnce(new AbortController().signal);
    assert.equal(h.calls(), 2);
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0].replyToId, 'one');
    assert.equal(h.sent[0].toAgent, 'grok');
    assert.equal(h.sent[0].threadId, 'thread_1');
    await h.listener().pollOnce(new AbortController().signal);
    assert.equal(h.calls(), 2, 'restart must not replay acknowledged events');
  } finally { h.cleanup(); }
});

test('logs incoming replies without replying; ignores other roles and self messages', async () => {
  const h = harness();
  try {
    h.add(message('answer', { replyToId: 'earlier' }));
    h.add(message('other-role', { toAgent: 'grok' }));
    h.add(message('self', { fromAgent: 'codex' }));
    const listener = h.listener();
    await listener.pollOnce(new AbortController().signal);
    await listener.pollOnce(new AbortController().signal);
    assert.equal(h.calls(), 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.log.length, 1);
    assert.match(h.log[0], /answer/);
  } finally { h.cleanup(); }
});

test('persisted outbox retries a lost POST response after restart without running AI twice', async () => {
  const h = harness();
  try {
    h.add(message('one'));
    h.failNextSend();
    await assert.rejects(h.listener().pollOnce(new AbortController().signal), /connection lost/);
    assert.equal(h.calls(), 1);
    await h.listener().pollOnce(new AbortController().signal);
    assert.equal(h.calls(), 1);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].idempotencyKey, 'worker_reply:codex:one');
  } finally { h.cleanup(); }
});

test('AI failure leaves the cursor for retry and never posts an empty/failed response', async () => {
  const h = harness();
  try {
    h.add(message('one'));
    const broken = new MessageListener(h.client, { async reply() { throw new Error('not logged in'); } },
      task.projectId, 'codex', path.join(h.directory, 'inbox.json'));
    await assert.rejects(broken.pollOnce(new AbortController().signal), /not logged in/);
    assert.equal(h.sent.length, 0);
    await h.listener().pollOnce(new AbortController().signal);
    assert.equal(h.calls(), 1);
    assert.equal(h.sent.length, 1);
  } finally { h.cleanup(); }
});

test('empty or oversized replies are not sent; existing peer answers prevent regenerated replies', async () => {
  const h = harness();
  try {
    h.add(message('one'));
    for (const content of ['', 'x'.repeat(16001)]) {
      const listener = new MessageListener(h.client, { async reply() { return content; } },
        task.projectId, 'codex', path.join(h.directory, 'bounds.json'));
      await assert.rejects(listener.pollOnce(new AbortController().signal), /1–16000/);
    }
    assert.equal(h.sent.length, 0);
    h.messages.push(message('already-answered', { fromAgent: 'codex', toAgent: 'grok', replyToId: 'one' }));
    await h.listener().pollOnce(new AbortController().signal);
    assert.equal(h.calls(), 0);
  } finally { h.cleanup(); }
});

test('cancelled and cross-project tasks cannot trigger AI; aborted polls do not send', async () => {
  const h = harness();
  try {
    h.add(message('one'));
    const cancelled = new MessageListener({ ...h.client, async getTask() { return { ...task, state: 'cancelled' as const }; } },
      h.responder, task.projectId, 'codex', path.join(h.directory, 'cancelled.json'));
    await cancelled.pollOnce(new AbortController().signal);
    const crossProject = new MessageListener({ ...h.client, async getTask() { return { ...task, projectId: 'other' }; } },
      h.responder, task.projectId, 'codex', path.join(h.directory, 'cross.json'));
    await assert.rejects(crossProject.pollOnce(new AbortController().signal), /another project/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(h.listener().pollOnce(abort.signal));
    assert.equal(h.calls(), 0);
    assert.equal(h.sent.length, 0);
  } finally { h.cleanup(); }
});

test('one local listener owns the inbox; stop removes its lock', async () => {
  const h = harness();
  const stop = new AbortController();
  const loop = h.listener().run(stop.signal, 10);
  try {
    await assert.rejects(h.listener().run(new AbortController().signal, 10), /already owned/);
  } finally {
    stop.abort(); await loop;
    assert.equal(fs.existsSync(path.join(h.directory, 'inbox.json.lock')), false);
    h.cleanup();
  }
});

test('Codex subprocess reads stdin and returns only final output, with text-only restrictions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-cli-test-'));
  const fakeCli = path.join(directory, 'fake.cjs');
  fs.writeFileSync(fakeCli, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    let input = '';
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      for (const arg of ['--ignore-user-config', '--ephemeral', 'read-only', 'shell_tool', 'unified_exec', 'web_search="disabled"']) {
        if (!args.includes(arg)) process.exit(9);
      }
      if (!input.includes('你好') || !input.includes('untrusted context')) process.exit(10);
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '端 B 已收到');
      console.log('diagnostic text that must not become the reply');
    });
  `);
  try {
    const responder = new CodexMessageResponder([process.execPath, fakeCli]);
    assert.equal(await responder.reply(message('one'), task, [], new AbortController().signal), '端 B 已收到');
    fs.writeFileSync(fakeCli, 'process.exit(7)');
    await assert.rejects(responder.reply(message('one'), task, [], new AbortController().signal), /failed/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Codex subprocess timeout terminates the responder and returns no reply', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-timeout-test-'));
  const fakeCli = path.join(directory, 'wait.cjs');
  fs.writeFileSync(fakeCli, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  try {
    const responder = new CodexMessageResponder([process.execPath, fakeCli], 500);
    await assert.rejects(responder.reply(message('one'), task, [], new AbortController().signal), /timed out/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Codex subprocess stops when the worker is cancelled', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-abort-test-'));
  const fakeCli = path.join(directory, 'wait.cjs');
  fs.writeFileSync(fakeCli, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 300);
  try {
    const responder = new CodexMessageResponder([process.execPath, fakeCli]);
    await assert.rejects(responder.reply(message('one'), task, [], stop.signal), /cancelled/);
    assert.deepEqual(codexCommand(fakeCli), [process.execPath, fakeCli]);
  } finally { clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true }); }
});
