import type { Config } from "./config.ts";
import { OpenBotAdapter, type OpenBotTransport } from "../../../packages/backends/src/openbot.ts";

/**
 * The OpenBot connection: OpenMuse's adapter to a deployed OpenBot
 * (the CopilotKit suite's Bot platform). Disabled by default; enabled via
 * OPENBOT_ENABLED=true with OPENBOT_BASE_URL pointing at the OpenBot
 * server (the integration recipe in docs/OPENBOT-INTEGRATION.md).
 *
 * Auth posture: OpenBot runs OPENBOT_SINGLE_USER=true in this deployment —
 * one administrator, no sign-in — so the transport carries no credentials.
 * If identity provider sessions arrive, this transport is where a
 * per-person authenticated request replaces the plain fetch.
 */

export type OpenBotConnectionStatus =
  | "disabled"
  | "unconfigured"
  | "connected"
  | "unavailable";

export class OpenBotConnection {
  readonly adapter: OpenBotAdapter | undefined;

  constructor(private readonly config: Config) {
    if (!config.openbotEnabled || !config.openbotBaseUrl) return;
    const base = config.openbotBaseUrl.replace(/\/$/, "");
    const transport: OpenBotTransport = {
      runtimeUrl: base + (config.openbotRuntimePath ?? "/api/copilotkit"),
      request: (path, init) => fetch(base + path, init),
    };
    this.adapter = new OpenBotAdapter({
      enabled: true,
      agentId: config.openbotAgentId,
      transport,
    });
  }

  /**
   * The connector status the workspace snapshot reports. "connected" means
   * the OpenBot deployment answered an authenticated probe — never a
   * simulated success (the integration boundary's own rule).
   */
  async status(): Promise<OpenBotConnectionStatus> {
    if (!this.adapter) return this.config.openbotEnabled ? "unconfigured" : "disabled";
    try {
      const probe = await this.adapter.probe();
      return probe.state === "authenticated" ? "connected" : "unavailable";
    } catch {
      return "unavailable";
    }
  }
}

export function createOpenBotConnection(config: Config): OpenBotConnection {
  return new OpenBotConnection(config);
}
