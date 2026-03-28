#!/usr/bin/env npx tsx
/**
 * google CLI — 搜索 + LLM 综合答案管线。
 *
 * 用法: npx tsx bin/google.ts "question text"
 * 输出: JSON to stdout（GoogleResult 形状）
 *
 * 管线：
 * 1. Engine API 获取 exaApiKey
 * 2. Exa Search API 搜索
 * 3. Engine API LLM synthesize 综合答案
 * 4. Engine API graph.write 存储结果
 *
 * @see docs/adr/202-engine-api.md
 */

import { engineGet, enginePost } from "../../_lib/engine-client.js";

// ── Exa Search API ──

async function exaSearch(
  query: string,
  apiKey: string,
): Promise<Array<{ title: string; url: string; text: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 3,
        contents: { text: { maxCharacters: 3000 } },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Exa API error: ${resp.status} ${resp.statusText}`);
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

const question = process.argv[2] ?? "";
if (!question.trim()) {
  console.error("Usage: google.ts <question>");
  process.exit(1);
}

// 1. 获取 Exa API key
const configResp = (await engineGet("/config/exaApiKey")) as { value: string } | null;
const exaApiKey = configResp?.value;
if (!exaApiKey) {
  console.error("EXA_API_KEY not configured");
  process.exit(1);
}

// 2. 搜索
const sources = await exaSearch(question, exaApiKey);
if (sources.length === 0) {
  console.error("Search returned no results");
  process.exit(1);
}

// 3. LLM 综合答案
const synthResp = (await enginePost("/llm/synthesize", {
  question,
  sources,
})) as { answer: string } | null;

const answer = synthResp?.answer ?? sources[0].text.slice(0, 800);

// 4. 存储到图
const citations = sources.slice(0, 5).map((s) => ({ title: s.title, url: s.url }));
const result = { answer, sources: citations };
await enginePost("/graph/self/last_google_result", { value: result });

// 5. 输出
console.log(JSON.stringify(result));
