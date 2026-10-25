import { Platform } from "react-native";
import { readApiPayload } from "./api-response";

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787")
).replace(/\/$/, "");

// Device persistence for the workspace access key — web builds only. The
// native apps keep the key in memory for the session, as before. On web the
// exported bundle reloads on every visit, so without this the live-mode
// gate re-asks for the key on every page load.
const ACCESS_KEY_STORAGE = "openmuse.accessKey";

function webStorage(): Storage | undefined {
  if (Platform.OS !== "web") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadSavedAccessKey(): string | undefined {
  try {
    return webStorage()?.getItem(ACCESS_KEY_STORAGE) || undefined;
  } catch {
    return undefined;
  }
}

export function saveAccessKey(key: string): void {
  try {
    webStorage()?.setItem(ACCESS_KEY_STORAGE, key);
  } catch {
    // Blocked storage (private mode) just means per-session sign-in, as before.
  }
}

export function clearSavedAccessKey(): void {
  try {
    webStorage()?.removeItem(ACCESS_KEY_STORAGE);
  } catch {
    // Nothing stored behaves the same as cleared.
  }
}

export class MuseApi {
  constructor(readonly token: string) {}
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const payload = await readApiPayload<T>(response);
    return payload;
  }
  url(path: string) {
    return path.startsWith("http") ? path : `${API_URL}${path}`;
  }
}

export async function createSession(
  accessKey?: string,
): Promise<{ token: string; mode: "sample" | "live" }> {
  const response = await fetch(`${API_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey }),
  });
  const payload = await readApiPayload<{ token: string; mode: "sample" | "live" }>(
    response,
    "Could not open your workspace.",
  );
  return payload;
}
