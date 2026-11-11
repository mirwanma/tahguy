// Supabase Edge Function: racikin-ai
// POST { task, profile, input } -> { data }
// Secret yang dibutuhkan: ANTHROPIC_API_KEY  (supabase secrets set ANTHROPIC_API_KEY=...)
import Anthropic from "npm:@anthropic-ai/sdk@0.137.0";
import { BASE_SYSTEM, TASKS } from "./tasks.ts";

const MODEL = Deno.env.get("RACIKIN_MODEL") ?? "claude-opus-5-5";
const ALLOWED_ORIGIN = Deno.env.get("RACIKIN_ALLOWED_ORIGIN") ?? "*";
const MAX_INPUT_CHARS = 20_000;

// Dibaca saat request (bukan saat boot) supaya secret yang baru di-set langsung terpakai.
let client: Anthropic | null = null;
function getClient() {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  client ??= new Anthropic({ apiKey: key });
  return client;
}

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const anthropic = getClient();
  if (!anthropic) {
    return json({ error: "Server AI belum siap: secret ANTHROPIC_API_KEY belum di-set di Supabase." }, 503);
  }

  let body: { task?: string; profile?: unknown; input?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body harus JSON" }, 400);
  }

  const def = body.task ? TASKS[body.task] : undefined;
  if (!def) return json({ error: `Task tidak dikenal: ${body.task}` }, 400);

  const context = JSON.stringify({ profil_bisnis: body.profile ?? {}, input: body.input ?? {} });
  if (context.length > MAX_INPUT_CHARS) return json({ error: "Input terlalu panjang" }, 413);

  try {
    // Server-side fallback: kalau model utama menolak (refusal), API otomatis
    // menjalankan ulang di model fallback dalam panggilan yang sama.
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: def.effort,
        format: { type: "json_schema", schema: def.schema },
      },
      system: [
        { type: "text", text: BASE_SYSTEM },
        { type: "text", text: `TUGAS:\n${def.instruction}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: `Data user (JSON):\n${context}\n\nKerjakan tugasnya dan jawab sesuai schema.`,
        },
      ],
    };
    const response = await anthropic.beta.messages.create(params);

    if (response.stop_reason === "refusal") {
      return json({ error: "AI tidak bisa memproses permintaan ini. Coba ubah kata-katanya ya." }, 422);
    }
    if (response.stop_reason === "max_tokens") {
      return json({ error: "Jawaban AI kepotong. Coba lagi dengan permintaan lebih kecil." }, 502);
    }

    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    return json({ data: JSON.parse(text) });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: "AI lagi sibuk banget, coba sebentar lagi." }, 429);
    }
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error", err.status, err.message);
      return json({ error: "Gagal menghubungi AI." }, 502);
    }
    console.error(err);
    return json({ error: "Terjadi kesalahan di server." }, 500);
  }
});
