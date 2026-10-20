import {
  RegisterWorkerInput,
  HeartbeatInput,
  ClaimRunInput,
  RenewRunInput,
  SubmitRunInput,
  FailRunInput,
  A2AEnvelope,
  Task,
  Run,
  Event,
  Message,
  SendMessageInput,
} from "@ai-collab/contracts";

export class HubClient {
  readonly baseUrl: string;
  readonly token?: string;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> || {}),
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hub 请求失败 [${res.status}]: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  async registerWorker(input: RegisterWorkerInput): Promise<any> {
    return this.request("/api/workers/register", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async sendHeartbeat(input: HeartbeatInput): Promise<void> {
    await this.request("/api/workers/heartbeat", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async claimRun(input: ClaimRunInput): Promise<{ task: Task; run: Run } | null> {
    const res = await this.request<{ claimed: boolean; data: { task: Task; run: Run } | null }>(
      "/api/runs/claim",
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
    return res.data;
  }

  async renewRun(input: RenewRunInput): Promise<Run> {
    return this.request(`/api/runs/${input.runId}/renew`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitRun(input: SubmitRunInput): Promise<Run> {
    return this.request(`/api/runs/${input.runId}/submit`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async failRun(input: FailRunInput): Promise<Run> {
    return this.request(`/api/runs/${input.runId}/fail`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async sendA2A(envelope: A2AEnvelope): Promise<any> {
    return this.request("/api/a2a/send", {
      method: "POST",
      body: JSON.stringify(envelope),
    });
  }

  async listEvents(projectId: string, after: number, signal?: AbortSignal): Promise<Event[]> {
    return this.request(`/api/events?projectId=${encodeURIComponent(projectId)}&after=${after}`, { signal });
  }

  async listMessages(taskId: string, threadId: string): Promise<Message[]> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/messages?threadId=${encodeURIComponent(threadId)}`);
  }

  async getTask(taskId: string): Promise<Task> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async sendMessage(input: SendMessageInput): Promise<unknown> {
    return this.request('/api/messages', { method: 'POST', body: JSON.stringify(input) });
  }

  async requeueTask(taskId: string): Promise<void> {
    await this.request(`/api/tasks/${encodeURIComponent(taskId)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'requeue' }),
    });
  }
}
