// Klien AI: mode "online" memanggil Supabase Edge Function racikin-ai,
// mode "demo" memakai generator lokal (tanpa internet / tanpa API key).
import { store } from "./store.js";
import { demo } from "./demo.js";

export async function ai(task, input = {}) {
  const { profile, settings } = store.get();
  if (settings.aiMode !== "online" || !settings.endpoint) {
    await new Promise((r) => setTimeout(r, 700 + Math.random() * 600));
    const fn = demo[task];
    if (!fn) throw new Error("Task demo belum ada: " + task);
    return fn(profile || {}, input, store.get());
  }

  const headers = { "Content-Type": "application/json" };
  if (settings.anonKey) {
    headers.Authorization = "Bearer " + settings.anonKey;
    headers.apikey = settings.anonKey;
  }
  let res;
  try {
    res = await fetch(settings.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ task, profile, input }),
    });
  } catch {
    throw new Error("Nggak bisa nyambung ke server AI. Cek internet atau URL endpoint.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server AI error (${res.status})`);
  return body.data;
}

export const isDemo = () => {
  const s = store.get().settings;
  return s.aiMode !== "online" || !s.endpoint;
};
