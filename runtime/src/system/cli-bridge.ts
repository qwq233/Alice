/**
 * Shared shell-native CLI bridge helpers.
 */

import { request } from "node:http";

function getEngineUrl(): URL {
  const raw = process.env.ALICE_ENGINE_URL;
  if (raw) return new URL(raw);
  const port = process.env.ALICE_ENGINE_PORT;
  if (port) return new URL(`http://127.0.0.1:${port}`);
  throw new Error("ALICE_ENGINE_URL or ALICE_ENGINE_PORT not set");
}

export function parseCliValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;

  const n = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(n) && /^-?\d+(?:\.\d+)?$/.test(raw)) {
    return n;
  }

  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

export function parseKeyValueArgs(args: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      throw new Error(`expected key=value, got "${arg}"`);
    }
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    body[key] = parseCliValue(value);
  }
  return body;
}

export async function enginePostJson(
  pathname: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = getEngineUrl();

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Alice-Skill": process.env.ALICE_SKILL ?? "alice-system",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(String(data.error ?? `request failed: ${res.statusCode}`)));
              return;
            }
            resolve(data);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

export function renderBridgeResult(result: unknown): string {
  if (result == null) return "null";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}
