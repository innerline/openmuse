import assert from "node:assert/strict";
import { test } from "node:test";
import { windowHistory } from "../apps/server/src/engine/history-window.ts";

function user(text: string) {
  return { id: crypto.randomUUID(), role: "user", content: text };
}
function assistant(text: string) {
  return { id: crypto.randomUUID(), role: "assistant", content: text };
}
// One turn = a user message, an assistant tool call, a tool result, then the
// assistant's reply — the grouping a cut must never split.
function toolTurn(text: string, toolText: string) {
  return [
    user(text),
    { id: crypto.randomUUID(), role: "assistant", toolCalls: [{ id: "t1" }] },
    { id: crypto.randomUUID(), role: "tool", content: toolText, toolCallId: "t1" },
    assistant(text),
  ];
}

test("under the high watermark the history is passed through untouched", () => {
  const messages = [user("hello"), assistant("hi")];
  const result = windowHistory(messages, 1000, 300);
  assert.equal(result.dropped, 0);
  assert.equal(result.messages, messages);
});

test("a non-positive high watermark disables windowing", () => {
  const messages = [user("hello"), assistant("hi")];
  const result = windowHistory(messages, 0, 0);
  assert.equal(result.dropped, 0);
  assert.equal(result.messages.length, 2);
});

test("over the high watermark it cuts back to the low watermark", () => {
  const turn = toolTurn("x".repeat(400), "y".repeat(400));
  const messages = [...turn, ...turn, ...turn, ...turn];
  const result = windowHistory(messages, 500, 500);
  assert.ok(result.dropped > 0);
  assert.ok(result.messages.length < messages.length);
  // The newest message always survives.
  assert.equal(result.messages.at(-1), messages.at(-1));
});

test("a cut never splits a tool-call group", () => {
  const turn = toolTurn("x".repeat(400), "y".repeat(400));
  const messages = [...turn, ...turn, ...turn];
  const result = windowHistory(messages, 500, 500);
  // Every kept group starts with a user message.
  let index = 0;
  while (index < result.messages.length) {
    assert.equal(result.messages[index].role, "user");
    index += 4;
  }
});

test("a tail whose first message alone overflows the low watermark is kept whole", () => {
  const giant = user("z".repeat(10_000));
  const messages = [user("small"), assistant("small"), giant];
  const result = windowHistory(messages, 1000, 500);
  assert.equal(result.dropped, 0);
  assert.equal(result.messages.length, 3);
});
