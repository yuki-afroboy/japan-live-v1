/**
 * Client for apps/gateway.
 *
 * The gateway handles transport: it holds the ODPT key, caches, rate-limits, and
 * returns a stable envelope. It does NOT interpret operator semantics — that lives in
 * the provider adapters here, where it can be tested against fixtures.
 */

export interface GatewayEnvelope<T = unknown> {
  ok: boolean;
  endpoint: string;
  /** When the gateway fetched from upstream. */
  fetchedAt: number;
  /** When the upstream says the data was generated, if it says. */
  sourceTimestamp?: number;
  /** True when the gateway served a cached body older than the feed's cadence. */
  stale?: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export class GatewayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

export interface GatewayClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** De-duplicates concurrent identical requests from this tab. */
  private readonly inFlight = new Map<string, Promise<GatewayEnvelope<unknown>>>();

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get<T>(path: string): Promise<GatewayEnvelope<T>> {
    const key = path;
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<GatewayEnvelope<T>>;

    const promise = this.request<T>(path).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise as Promise<GatewayEnvelope<unknown>>);
    return promise;
  }

  private async request<T>(path: string): Promise<GatewayEnvelope<T>> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });

      if (!res.ok) {
        return {
          ok: false,
          endpoint: path,
          fetchedAt: Date.now(),
          error: { code: `HTTP_${res.status}`, message: `gateway returned ${res.status}` },
        };
      }

      const body = (await res.json()) as GatewayEnvelope<T>;
      // Trust the envelope's own shape, but never let a malformed body look successful.
      if (typeof body !== "object" || body === null || typeof body.ok !== "boolean") {
        return {
          ok: false,
          endpoint: path,
          fetchedAt: Date.now(),
          error: { code: "BAD_ENVELOPE", message: "gateway response was not a valid envelope" },
        };
      }
      return body;
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        endpoint: path,
        fetchedAt: Date.now(),
        error: {
          code: aborted ? "TIMEOUT" : "NETWORK",
          message: aborted ? "gateway request timed out" : "gateway unreachable",
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
