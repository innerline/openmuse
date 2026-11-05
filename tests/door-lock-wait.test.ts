import assert from "node:assert/strict";
import { test } from "node:test";
import {
  intFromEnv,
  LOCK_HEARTBEAT_SECONDS,
  LOCK_RETRY_FIRST_DELAYS_MS,
  LOCK_RETRY_STEADY_DELAY_MS,
  LOCK_TTL_SECONDS,
  LOCK_WAIT_BUDGET_MS,
  lockRetryDelayMs,
} from "../apps/server/src/config.ts";

/*
 * 2026-11-05 isolation board (door-larry lane, 11/12 turns dropped): the door's lock
 * wait expired into a 409 after 24s while the previous turn — minutes long under load —
 * still held the thread, and the runtime's default lock pacing (TTL 20s, heartbeat 15s)
 * aborted live runs on a single missed heartbeat. These tests pin the two sizings that
 * fix it: the wait outlives a loaded turn, and the heartbeat renews comfortably inside
 * the TTL.
 */

test("intFromEnv falls back on missing, unparsable, and clamps out-of-range values", () => {
  const name = "TEST_INT_FROM_ENV";
  delete process.env[name];
  assert.equal(intFromEnv(name, 7, 5, 100), 7);
  process.env[name] = "42";
  assert.equal(intFromEnv(name, 7, 5, 100), 42);
  process.env[name] = "1";
  assert.equal(intFromEnv(name, 7, 5, 100), 5);
  process.env[name] = "1000";
  assert.equal(intFromEnv(name, 7, 5, 100), 100);
  process.env[name] = "not-a-number";
  assert.equal(intFromEnv(name, 7, 5, 100), 7);
  process.env[name] = "  ";
  assert.equal(intFromEnv(name, 7, 5, 100), 7);
  delete process.env[name];
});

test("lock pacing renews comfortably inside the TTL (a missed heartbeat is absorbed)", () => {
  // At least two heartbeat intervals must fit inside one TTL window, or a single
  // transient heartbeat miss (e.g. a gateway fetch failure) can expire a live run's
  // lock and abort it mid-stream.
  assert.ok(
    LOCK_TTL_SECONDS >= 2 * LOCK_HEARTBEAT_SECONDS,
    `TTL ${LOCK_TTL_SECONDS}s must cover at least two ${LOCK_HEARTBEAT_SECONDS}s heartbeats`,
  );
});

test("lock retries start fast, then wait steadily for as long as the budget holds", () => {
  assert.equal(lockRetryDelayMs(0, 0), LOCK_RETRY_FIRST_DELAYS_MS[0]);
  assert.equal(lockRetryDelayMs(1, 4_000), LOCK_RETRY_FIRST_DELAYS_MS[1]);
  // Steady regime: the budget is minutes, not the old 24s.
  assert.ok(LOCK_WAIT_BUDGET_MS >= 300_000, "budget must be sized to loaded turns");
  assert.equal(lockRetryDelayMs(2, 12_000), LOCK_RETRY_STEADY_DELAY_MS);
  assert.equal(
    lockRetryDelayMs(2, LOCK_WAIT_BUDGET_MS - LOCK_RETRY_STEADY_DELAY_MS),
    LOCK_RETRY_STEADY_DELAY_MS,
  );
  // One millisecond past the affordable end, the 409 surfaces instead of another wait.
  assert.equal(
    lockRetryDelayMs(2, LOCK_WAIT_BUDGET_MS - LOCK_RETRY_STEADY_DELAY_MS + 1),
    null,
  );
  assert.equal(lockRetryDelayMs(99, LOCK_WAIT_BUDGET_MS), null);
});
