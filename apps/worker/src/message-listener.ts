import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MessageSchema, SendMessageInputSchema, type Event, type Message, type SendMessageInput, type Task } from '@ai-collab/contracts';
import type { HubClient } from './client.js';

export interface MessageResponder {
  reply(message: Message, task: Task, history: Message[], signal: AbortSignal): Promise<string>;
}

interface InboxState {
  cursor: number;
  pending?: { eventId: number; message: SendMessageInput };
}

/** One durable, serial consumer per Hub/project/agent role. Replies never trigger replies. */
export class MessageListener {
  private state: InboxState;
  private polling = false;

  constructor(
    private readonly client: Pick<HubClient, 'listEvents' | 'listMessages' | 'getTask' | 'sendMessage'>,
    private readonly responder: MessageResponder,
    private readonly projectId: string,
    private readonly agentType: 'grok' | 'codex',
    private readonly stateFile: string,
    private readonly log: (line: string) => void = console.log,
  ) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    this.state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { cursor: 0 };
    if (!Number.isSafeInteger(this.state.cursor) || this.state.cursor < 0) {
      throw new Error(`Invalid message cursor: ${stateFile}`);
    }
    if (this.state.pending) {
      const pending = this.state.pending;
      SendMessageInputSchema.parse(pending.message);
      if (!Number.isSafeInteger(pending.eventId) || pending.eventId <= this.state.cursor ||
          pending.message.projectId !== projectId || pending.message.fromAgent !== agentType || !pending.message.replyToId) {
        throw new Error(`Invalid pending reply: ${stateFile}`);
      }
    }
  }

  private save(): void {
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }

  private async flushPending(signal: AbortSignal): Promise<void> {
    if (!this.state.pending) return;
    signal.throwIfAborted();
    await this.client.sendMessage(this.state.pending.message);
    this.state.cursor = this.state.pending.eventId;
    delete this.state.pending;
    this.save();
  }

  /** Safe to call again after network/process failures; persist generated text before sending. */
  async pollOnce(signal: AbortSignal): Promise<void> {
    if (this.polling) throw new Error('Message poll already in progress');
    this.polling = true;
    try {
      await this.flushPending(signal);
      const events = await this.client.listEvents(this.projectId, this.state.cursor, signal);
      for (const event of events.sort((a, b) => a.id - b.id)) {
        signal.throwIfAborted();
        if (event.id <= this.state.cursor) continue;
        if (event.projectId !== this.projectId) throw new Error('Hub returned an event for another project');
        if (event.type === 'message_sent') await this.receive(event, signal);
        signal.throwIfAborted();
        this.state.cursor = event.id;
        this.save();
      }
    } finally {
      this.polling = false;
    }
  }

  private async receive(event: Event, signal: AbortSignal): Promise<void> {
    // PostgreSQL embeds payload.message; memory storage emits flattened fields.
    const embedded = event.payload.message as Partial<Message> | undefined;
    const to = embedded?.toAgent ?? event.payload.to;
    if (to !== this.agentType) return;
    const taskId = embedded?.taskId ?? event.taskId;
    const threadId = embedded?.threadId ?? event.payload.threadId;
    const messageId = embedded?.id ?? event.payload.messageId;
    if (!taskId || typeof threadId !== 'string' || typeof messageId !== 'string') {
      throw new Error(`Malformed message event ${event.id}`);
    }
    // Read the canonical message, rather than treating an event payload as a command.
    const history = (await this.client.listMessages(taskId, threadId)).map(m => MessageSchema.parse(m))
      .filter(m => m.projectId === this.projectId && m.taskId === taskId && m.threadId === threadId);
    const message = history.find(m => m.id === messageId);
    if (!message) throw new Error(`Message ${messageId} missing from Hub`);
    if (message.projectId !== this.projectId || message.taskId !== taskId ||
        message.threadId !== threadId || message.toAgent !== this.agentType || message.fromAgent === this.agentType) return;
    this.log(`[Message received] ${message.id}: ${message.content}`);
    if (message.replyToId) return; // Receive/log answers, but do not start an infinite bot-to-bot loop.
    if (history.some(m => m.replyToId === message.id && m.fromAgent === this.agentType)) return;

    const task = await this.client.getTask(taskId);
    if (task.projectId !== this.projectId) throw new Error('Message task belongs to another project');
    if (task.state === 'cancelled') return;
    const content = (await this.responder.reply(message, task, history.slice(-20), signal)).trim();
    signal.throwIfAborted();
    if (!content || content.length > 16000) throw new Error('AI reply must contain 1–16000 characters');
    this.state.pending = {
      eventId: event.id,
      message: {
        projectId: this.projectId, taskId, threadId,
        fromAgent: this.agentType, toAgent: message.fromAgent,
        content, replyToId: message.id,
        idempotencyKey: `worker_reply:${this.agentType}:${message.id}`,
      },
    };
    this.save();
    await this.flushPending(signal);
    this.log(`[Message replied] ${message.id}`);
  }

  async run(signal: AbortSignal, pollMs = 2000): Promise<void> {
    // Prevent two local Worker processes from spending tokens/replying for the same role.
    const lockFile = `${this.stateFile}.lock`;
    for (;;) {
      try {
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number(fs.readFileSync(lockFile, 'utf8'));
        if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error(`Invalid inbox lock: ${lockFile}`);
        try { process.kill(owner, 0); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') { fs.unlinkSync(lockFile); continue; }
          throw err;
        }
        throw new Error(`Inbox already owned by process ${owner}`);
      }
    }
    let backoff = pollMs;
    try {
      while (!signal.aborted) {
        try {
          await this.pollOnce(signal);
          backoff = pollMs;
        } catch (error) {
          if (signal.aborted) break;
          this.log(`[Message retry] ${(error as Error).message}`);
          backoff = Math.min(backoff * 2, 30000);
        }
        try { await delay(backoff, undefined, { signal }); } catch { break; }
      }
    } finally {
      fs.unlinkSync(lockFile);
    }
  }
}
