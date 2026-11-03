import { PodConfig, TincanEnvelope } from "./types.js";

export type CustomFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Adds the Factory Hub bearer credential to a request init, preserving existing headers. */
export function withHubAuth(init: RequestInit | undefined, token: string | undefined): RequestInit | undefined {
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export class TincanClient {
  private config: PodConfig;
  private fetcher: CustomFetcher;

  constructor(config: PodConfig, serviceBindingOrFetcher?: { fetch: CustomFetcher } | CustomFetcher) {
    this.config = config;
    if (serviceBindingOrFetcher) {
      if (typeof serviceBindingOrFetcher === "function") {
        this.fetcher = serviceBindingOrFetcher;
      } else if (typeof serviceBindingOrFetcher.fetch === "function") {
        this.fetcher = serviceBindingOrFetcher.fetch.bind(serviceBindingOrFetcher);
      } else {
        this.fetcher = (input, init) => fetch(input, init);
      }
    } else {
      this.fetcher = (input, init) => fetch(input, init);
    }
    const base = this.fetcher;
    this.fetcher = (input, init) => base(input, withHubAuth(init, config.hubToken));
  }

  public async sendHeartbeat(): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.config.hubUrl}/api/tincan/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "pod.heartbeat",
          fromPod: this.config.id,
          toPod: "pod:pm",
          payload: {
            id: this.config.id,
            name: this.config.name,
            role: this.config.role,
            lob: this.config.lob,
            capabilities: this.config.capabilities,
            timestamp: Date.now(),
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      console.warn(`[tincan-client] Heartbeat to ${this.config.hubUrl} failed:`, err);
      return false;
    }
  }

  public async pollInbox(limit = 10): Promise<TincanEnvelope[]> {
    try {
      const url = `${this.config.hubUrl}/api/tincan/messages?pod=${encodeURIComponent(this.config.id)}&limit=${limit}`;
      const res = await this.fetcher(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) return [];
      const data = (await res.json()) as any;
      return Array.isArray(data.messages) ? data.messages : [];
    } catch (err) {
      console.warn(`[tincan-client] Polling ${this.config.hubUrl} failed:`, err);
      return [];
    }
  }

  public async acknowledge(messageId: string): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.config.hubUrl}/api/tincan/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      console.warn(`[tincan-client] Ack failed for ${messageId}:`, err);
      return false;
    }
  }

  public async publish<T = any>(topic: string, toPod: string, payload: T): Promise<boolean> {
    try {
      const res = await this.fetcher(`${this.config.hubUrl}/api/tincan/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          fromPod: this.config.id,
          toPod,
          payload,
        }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      console.warn(`[tincan-client] Publish ${topic} failed:`, err);
      return false;
    }
  }
}
