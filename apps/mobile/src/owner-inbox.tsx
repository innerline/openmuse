// Brian's owner inbox — the ask register from the MWP vault
// (kanban/owner-inbox.json) rendered inside the app instead of a boards
// page (owner order 2026-10-30). Asks routed `for: "larry"` wait on his
// word; `whenever` items are plain notes, never asks. Answering happens
// by talking to Larry in chat — this screen only informs, no buttons.
import { Inbox } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, AppState, Text, View } from "react-native";
import { API_URL } from "./api";
import { Card, colors, dateLabel, Empty, ErrorNotice, relativeDate, s } from "./ui";

interface OwnerInboxAsk {
  id: string;
  for: string;
  title: string;
  body: string;
  how: string;
  added: string;
}
interface OwnerInbox {
  updated: string;
  asks: OwnerInboxAsk[];
  whenever: string[];
}

// Same-origin on web: the static host serves the vault file at this path at
// request time, so edits land without a rebuild. Native points at API_URL
// and reports quietly if nothing serves it yet.
function inboxUrl() {
  return `${API_URL}/kanban/owner-inbox.json`.replace(/^\.\//, "/");
}

export function OwnerInboxScreen() {
  const [data, setData] = useState<OwnerInbox>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(inboxUrl());
      if (!response.ok) throw new Error(`The inbox is unreachable (${response.status}).`);
      setData((await response.json()) as OwnerInbox);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Re-read the register whenever the app comes back to the front — the
  // JSON changes on its own, without any rebuild.
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => listener.remove();
  }, [refresh]);
  const asks = (data?.asks || []).filter((ask) => ask.for === "larry");
  const whenever = data?.whenever || [];
  return (
    <View style={{ gap: 20 }}>
      <ErrorNotice error={error} />
      {busy && !data ? (
        <ActivityIndicator color={colors.blueDark} style={{ padding: 30 }} />
      ) : (
        <>
          <View style={{ gap: 8 }}>
            <Text style={s.heading}>Asks for you</Text>
            <Text style={s.muted}>Waiting on your word — answer by telling Larry in chat.</Text>
          </View>
          {asks.map((ask) => (
            <Card key={ask.id} style={{ gap: 8 }}>
              <Text style={s.heading}>{ask.title}</Text>
              <Text style={s.muted}>{ask.body}</Text>
              <Text style={s.text}>{ask.how}</Text>
              <Text style={s.small}>Added {dateLabel(ask.added)}</Text>
            </Card>
          ))}
          {!asks.length && !error && (
            <Empty
              icon={Inbox}
              title="Nothing needs you"
              detail="No asks are waiting on your word. When one lands, it appears here."
            />
          )}
          {!!whenever.length && (
            <View style={{ gap: 12 }}>
              <Text style={s.heading}>Whenever</Text>
              <Text style={s.small}>Notes for someday. Not asks — nothing waits on these.</Text>
              {whenever.map((item) => (
                <View
                  key={item}
                  style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}
                >
                  <Text style={{ color: colors.muted, lineHeight: 21 }}>•</Text>
                  <Text style={[s.muted, { flex: 1 }]}>{item}</Text>
                </View>
              ))}
            </View>
          )}
          {!!data?.updated && <Text style={s.small}>Updated {relativeDate(data.updated)}</Text>}
        </>
      )}
    </View>
  );
}
