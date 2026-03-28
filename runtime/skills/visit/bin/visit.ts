#!/usr/bin/env npx tsx
/**
 * visit CLI — URL 内容提取 + LLM 摘要管线。
 *
 * 用法: npx tsx bin/visit.ts "https://example.com" ["focus text"]
 * 输出: JSON to stdout（VisitResult 形状）
 *
 * 管线：
 * 1. Engine API 获取 exaApiKey
 * 2. Exa Contents API 提取页面内容
 * 3. Engine API LLM summarize 摘要
 * 4. Engine API graph.write 存储结果
 *
 * @see docs/adr/202-engine-api.md
 */

import { engineGet, enginePost } from "../../_lib/engine-client.js";

// ── Exa Contents API ──

async function exaExtract(
  urls: string[],
  apiKey: string,
): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const resp = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        urls,
        text: { maxCharacters: 6000 },
        livecrawl: "fallback",
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Exa Contents API error: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as {
      results: Array<{ title: string; url: string; text: string }>;
    };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      text: r.text ?? "",
    }));
  } finally {
    clearTimeout(timeout);
  }
}

// ── main ──

const url = process.argv[2] ?? "";
if (!url.trim() || !/^https?:\/\//i.test(url)) {
  console.error("Usage: visit.ts <url> [focus]");
  process.exit(1);
}

const focus = process.argv[3]?.trim() || undefined;

// 1. 获取 Exa API key
const configResp = (await engineGet("/config/exaApiKey")) as { value: string } | null;
const exaApiKey = configResp?.value;
if (!exaApiKey) {
  console.error("EXA_API_KEY not configured");
  process.exit(1);
}

// 2. 提取页面内容
const raw = await exaExtract([url], exaApiKey);
if (raw.length === 0 || !raw[0].text) {
  console.error("URL extraction returned empty");
  process.exit(1);
}

// 3. LLM 摘要
const summarizeResp = (await enginePost("/llm/summarize", {
  text: raw[0].text,
  url: raw[0].url,
  focus,
})) as { summary: string } | null;

const summary = summarizeResp?.summary ?? raw[0].text.slice(0, 800);

// 4. 存储到图
const result = {
  title: raw[0].title || "(untitled)",
  url: raw[0].url,
  summary,
};
await enginePost("/graph/self/last_visit_result", { value: result });

// 5. 输出
console.log(JSON.stringify(result));
