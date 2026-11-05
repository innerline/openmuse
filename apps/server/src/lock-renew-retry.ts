import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { LOCK_RENEW_RETRIES, LOCK_RENEW_RETRY_DELAY_MS } from "./config.ts";

/*
 * The runtime's run handler treats ONE failed lock renewal as fatal: it aborts the live
 * run mid-stream. A renew is a plain HTTP fetch fired every heartbeat interval, so a
 * transient socket failure — classically an idle keep-alive connection closed by the
 * gateway at the exact moment of reuse — kills an otherwise healthy turn. Retry the
 * renew before letting the failure through: the TTL window is minutes (LOCK_TTL_SECONDS
 * in config.ts), so a retry landing seconds later still holds the lock. Only a gateway
 * unreachable for every attempt reaches the runtime's abort, which is what that abort
 * is for.
 */
export function withLockRenewRetry(intelligence: CopilotKitIntelligence): CopilotKitIntelligence {
  const original = intelligence.ɵrenewThreadLock.bind(intelligence);
  intelligence.ɵrenewThreadLock = async (input: Parameters<typeof original>[0]) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < LOCK_RENEW_RETRIES; attempt++) {
      if (attempt > 0)
        await new Promise((resolve) => setTimeout(resolve, LOCK_RENEW_RETRY_DELAY_MS));
      try {
        return await original(input);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };
  return intelligence;
}
