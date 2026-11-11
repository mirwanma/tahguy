// Supabase Edge Function: racikin-ai
// POST { task, profile, input } -> { data }
//
// Provider AI dipilih dari secret yang tersedia:
//   1. GEMINI_API_KEY (atau GOOGLE_API_KEY)  -> Google Gemini   (utama)
//   2. ANTHROPIC_API_KEY                      -> Claude          (cadangan)
// Secret opsional: GEMINI_MODEL, RACIKIN_MODEL (Claude), RACIKIN_ALLOWED_ORIGIN
import Anthropic from "npm:@anthropic-ai/sdk@0.137.0";
import { BASE_SYSTEM, TASKS, type TaskDef } from "./tasks.ts";

const ALLOWED_ORIGIN = Deno.env.get("RACIKIN_ALLOWED_ORIGIN") ?? "*";
const MAX_INPUT_CHARS = 20_000;

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

/** Error dengan pesan yang aman ditampilkan ke user. */
class UserError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// ---------- Gemini ----------
const GEMINI_MODELS = [Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash", "gemini-3.6-flash"];
const THINKING: Record<TaskDef["effort"], string> = { low: "LOW", medium: "MEDIUM", high: "HIGH" };

async function callGemini(apiKey: string, def: TaskDef, userText: string): Promise<unknown> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: `${BASE_SYSTEM}\n\nTUGAS:\n${def.instruction}` }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: def.schema,
      maxOutputTokens: 16000,
      thinkingConfig: { thinkingLevel: THINKING[def.effort] },
    },
  });

  // Coba model utama; kalau model tidak ditemukan (404), pakai model cadangan.
  for (const [i, model] of [...new Set(GEMINI_MODELS)].entries()) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
    });
    if (res.status === 404 && i < GEMINI_MODELS.length - 1) {
      console.warn(`Model ${model} tidak ditemukan, coba cadangan`);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("Gemini API error", res.status, JSON.stringify(data).slice(0, 500));
      if (res.status === 429) throw new UserError("AI lagi sibuk / kuota habis, coba sebentar lagi.", 429);
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new UserError("API key Gemini ditolak. Cek secret GEMINI_API_KEY di Supabase.", 502);
      }
      throw new UserError("Gagal menghubungi AI.", 502);
    }

    if (data.promptFeedback?.blockReason) {
      throw new UserError("AI tidak bisa memproses permintaan ini. Coba ubah kata-katanya ya.", 422);
    }
    const cand = data.candidates?.[0];
    if (cand?.finishReason === "MAX_TOKENS") {
      throw new UserError("Jawaban AI kepotong. Coba lagi dengan permintaan lebih kecil.", 502);
    }
    const text = (cand?.content?.parts ?? [])
      .filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought)
      .map((p: { text: string }) => p.text)
      .join("");
    if (!text) {
      console.error("Gemini response kosong", JSON.stringify(data).slice(0, 500));
      throw new UserError("AI tidak memberi jawaban. Coba lagi ya.", 502);
    }
    return JSON.parse(text);
  }
  throw new UserError("Model Gemini tidak tersedia.", 502);
}

// ---------- Claude (cadangan) ----------
let anthropic: Anthropic | null = null;
async function callClaude(apiKey: string, def: TaskDef, userText: string): Promise<unknown> {
  anthropic ??= new Anthropic({ apiKey });
  // deno-lint-ignore no-explicit-any
  const params: any = {
    model: Deno.env.get("RACIKIN_MODEL") ?? "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: def.effort, format: { type: "json_schema", schema: def.schema } },
    system: [
      { type: "text", text: BASE_SYSTEM },
      { type: "text", text: `TUGAS:\n${def.instruction}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userText }],
  };
  try {
    const response = await anthropic.beta.messages.create(params);
    if (response.stop_reason === "refusal") {
      throw new UserError("AI tidak bisa memproses permintaan ini. Coba ubah kata-katanya ya.", 422);
    }
    if (response.stop_reason === "max_tokens") {
      throw new UserError("Jawaban AI kepotong. Coba lagi dengan permintaan lebih kecil.", 502);
    }
    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new UserError("AI lagi sibuk banget, coba sebentar lagi.", 429);
    if (err instanceof Anthropic.APIError) {
      console.error("Anthropic API error", err.status, err.message);
      throw new UserError("Gagal menghubungi AI.", 502);
    }
    throw err;
  }
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Dibaca per request supaya secret yang baru di-set langsung terpakai.
  const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY");
  const claudeKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!geminiKey && !claudeKey) {
    return json({ error: "Server AI belum siap: secret GEMINI_API_KEY belum di-set di Supabase." }, 503);
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
  const userText = `Data user (JSON):\n${context}\n\nKerjakan tugasnya dan jawab sesuai schema.`;

  try {
    const data = geminiKey ? await callGemini(geminiKey, def, userText) : await callClaude(claudeKey!, def, userText);
    return json({ data });
  } catch (err) {
    if (err instanceof UserError) return json({ error: err.message }, err.status);
    if (err instanceof SyntaxError) {
      console.error("JSON AI tidak valid", err.message);
      return json({ error: "Jawaban AI formatnya rusak. Coba lagi ya." }, 502);
    }
    console.error(err);
    return json({ error: "Terjadi kesalahan di server." }, 500);
  }
});
