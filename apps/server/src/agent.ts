import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  type CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import { createJevAdapter, type JevAdapter } from "./jev/adapter.ts";

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          config.model &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY),
        ))
  );
}
export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  /**
   * The Intelligence platform client, or undefined for the open-source runtime mode. The v2
   * runtime infers its mode from this argument's presence: with it, threads and runs go through
   * the platform (join-token envelope, gateway socket); without it, a run answers with the AG-UI
   * event stream on the response itself and threads are the caller's. See app.ts for which
   * deployments select which mode.
   */
  intelligence: CopilotKitIntelligence | undefined,
) {
  // Built on first use, then shared so live mode reuses one TypeSafe client across requests.
  let jevAdapter: JevAdapter | undefined;
  const sharedJevAdapter = () => (jevAdapter ??= createJevAdapter(config));
  const agents: AgentsFactory = async ({ request }) => ({
    default:
      config.agentBackend === "sample"
        ? new ConversationAgent(
            config,
            service,
            await auth.owner(request.headers.get("authorization") ?? undefined),
            sharedJevAdapter(),
          )
        : config.agentBackend === "agui"
          ? new HttpAgent({
              url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
              headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
            })
          : new ConversationAgent(
              config,
              service,
              await auth.owner(request.headers.get("authorization") ?? undefined),
              sharedJevAdapter(),
            ),
  });
  // Two calls rather than one with a conditional spread: the runtime's option types are a union
  // keyed on the PRESENCE of `intelligence` (platform mode vs open-source mode), and a spread of
  // `...(intelligence ? { intelligence } : {})` widens the property to `| undefined`, which
  // matches neither overload. Naming the two modes lets the compiler check each against its own.
  const runtime = intelligence
    ? new CopilotRuntime({
        agents,
        intelligence,
        // The shared CopilotKit sink carries this tag onto existing PostHog events.
        telemetryProperties: { accessibility_title: "OpenMuse" },
        identifyUser: async (request) => ({
          id: await auth.owner(request.headers.get("authorization") ?? undefined),
          name: "OpenMuse user",
        }),
        generateThreadNames: false,
      })
    : new CopilotRuntime({
        agents,
        telemetryProperties: { accessibility_title: "OpenMuse" },
        identifyUser: async (request: Request) => ({
          id: await auth.owner(request.headers.get("authorization") ?? undefined),
          name: "OpenMuse user",
        }),
      });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
