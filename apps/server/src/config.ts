import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
// Capture the full setup/activation funnel while preserving explicit SDK opt-outs
// and any deployment-specific sampling rate. Config loads before runtime imports.
process.env.COPILOTKIT_TELEMETRY_SAMPLE_RATE ??= "1";

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  openbotEnabled?: boolean;
  openbotBaseUrl?: string;
  openbotRuntimePath?: string;
  openbotAgentId?: string;
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  webSearchEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  computerProvider?: ComputerProvider;
  computerE2bTemplate?: string;
  e2bApiKey?: string;
  allowedOrigins: string[];
  trustProxy?: boolean;
}

export type ComputerProvider = "docker" | "e2b-desktop";

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

export const intelligenceKeyRequiredMessage =
  "OpenMuse requires CPK_INTELLIGENCE_API_KEY. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

/**
 * The partial-set law, shared with the URL and gateway checks below: a deployment that sets SOME
 * of the Intelligence contract and not all of it meant to configure the platform thread store and
 * got it wrong, so it refuses to start rather than silently serving without durable threads.
 * (2026-10-30: OpenMuse also runs fully without Intelligence — the open-source runtime mode —
 * which is what an empty contract now selects. See agent.ts makeRuntime.)
 */
export const intelligencePartialSetMessage =
  "Intelligence is half-configured: CPK_INTELLIGENCE_API_KEY, INTELLIGENCE_API_URL and " +
  "INTELLIGENCE_GATEWAY_WS_URL must be set together, or all left unset to run on the " +
  "open-source runtime without the Intelligence platform.";

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

export function assertApiDeploymentConfig(
  config: Config,
): asserts config is Config & { intelligenceApiKey: string | undefined } {
  const key = config.intelligenceApiKey?.trim() ?? "";
  const url = process.env.INTELLIGENCE_API_URL?.trim() ?? "";
  const gateway = process.env.INTELLIGENCE_GATEWAY_WS_URL?.trim() ?? "";
  // All three unset = open-source runtime mode: no Intelligence platform, no license, no
  // vendor check-in. The runtime serves AG-UI streams itself and threads live client-side.
  if (!key && !url && !gateway) return;
  // Any of them set = Intelligence mode, and then the whole contract must be present.
  if (!key || !url || !gateway) throw new Error(intelligencePartialSetMessage);
  required("CPK_INTELLIGENCE_API_KEY", intelligenceKeyRequiredMessage, key);
}

/** Accept a full worker URL, or host:port from a platform that omits the scheme. */
export function browserWorkerUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;

/** An integer env var read once at startup: out-of-range or unparsable falls back. */
export function intFromEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/*
 * Thread-lock pacing for the local-model lane. The runtime's defaults (TTL 20s, heartbeat
 * 15s) are sized for cloud-model turn times; a loaded local turn runs minutes, and one
 * transient heartbeat miss inside that 20s window aborts the live run mid-stream — the
 * "reply cut while the agent was still working" signature on this door. Renew
 * comfortably inside the TTL instead: a missed heartbeat (a gateway hiccup) costs one
 * 60s interval and is absorbed, while a lock abandoned by a crashed server still expires
 * within the TTL. Env-tunable because loaded-turn times are a property of the engine,
 * not of this app.
 */
export const LOCK_TTL_SECONDS = intFromEnv("MUSE_LOCK_TTL_SECONDS", 300, 5, 3600);
export const LOCK_HEARTBEAT_SECONDS = intFromEnv(
  "MUSE_LOCK_HEARTBEAT_SECONDS",
  60,
  1,
  3600,
);
/*
 * How long the door waits out a thread whose previous run is still executing, before the
 * 409 surfaces to the caller. Sized to outlive a LOADED turn (minutes on the local
 * engine), not an abandoned lock's TTL — the run in front holds its lock for as long as
 * it is alive. See the retry loop in app.ts.
 */
export const LOCK_WAIT_BUDGET_MS = intFromEnv(
  "MUSE_LOCK_WAIT_BUDGET_MS",
  600_000,
  24_000,
  3_600_000,
);
/*
 * The retry cadence the door paces those waits with: the first attempts are quick (they
 * cover a just-finished turn), then a steady interval for as long as the budget holds.
 */
export const LOCK_RETRY_FIRST_DELAYS_MS = [4_000, 8_000] as const;
export const LOCK_RETRY_STEADY_DELAY_MS = 15_000;

/**
 * The delay before lock-retry `attempt` (0-based) given `waitedMs` already spent
 * waiting, or null when the budget is spent and the 409 should surface to the caller.
 */
export function lockRetryDelayMs(attempt: number, waitedMs: number): number | null {
  if (attempt < LOCK_RETRY_FIRST_DELAYS_MS.length)
    return LOCK_RETRY_FIRST_DELAYS_MS[attempt];
  return waitedMs + LOCK_RETRY_STEADY_DELAY_MS <= LOCK_WAIT_BUDGET_MS
    ? LOCK_RETRY_STEADY_DELAY_MS
    : null;
}

export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const computerProvider = process.env.COMPUTER_PROVIDER?.trim() || "docker";
  if (computerProvider !== "docker" && computerProvider !== "e2b-desktop")
    throw new Error("COMPUTER_PROVIDER must be docker or e2b-desktop");
  const e2bApiKey = process.env.E2B_API_KEY?.trim();
  if (process.env.COMPUTER_ENABLED === "true" && computerProvider === "e2b-desktop") {
    if (!e2bApiKey)
      throw new Error("COMPUTER_PROVIDER=e2b-desktop requires a nonblank E2B_API_KEY");
    // Sandboxes are matched by metadata across the whole E2B team, and every default
    // install would otherwise derive the same deployment label from localhost:8787.
    if (!process.env.COMPUTER_DEPLOYMENT_ID?.trim())
      throw new Error(
        "COMPUTER_PROVIDER=e2b-desktop requires a unique COMPUTER_DEPLOYMENT_ID, e.g. from `openssl rand -hex 12`",
      );
  }
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    openbotEnabled: process.env.OPENBOT_ENABLED === "true",
    openbotBaseUrl: process.env.OPENBOT_BASE_URL?.trim() || undefined,
    openbotRuntimePath: process.env.OPENBOT_RUNTIME_PATH?.trim() || "/api/copilotkit",
    openbotAgentId: process.env.OPENBOT_AGENT_ID?.trim() || undefined,
    intelligenceApiKey: process.env.CPK_INTELLIGENCE_API_KEY?.trim() || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: browserWorkerUrl(process.env.BROWSER_WORKER_URL),
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    webSearchEnabled: process.env.WEB_SEARCH_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    computerProvider,
    computerE2bTemplate: process.env.COMPUTER_E2B_TEMPLATE?.trim() || "desktop",
    e2bApiKey,
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
    // Only trust X-Forwarded-For/X-Real-IP when the deployment is known to sit
    // behind a proxy that sets them; otherwise a direct caller can spoof them.
    trustProxy: process.env.TRUST_PROXY === "true",
  };
  if (
    mode === "live" &&
    (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey)
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  return config;
}
