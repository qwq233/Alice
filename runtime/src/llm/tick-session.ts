/**
 * Tick LLM session store — provider-side response chain reuse.
 *
 * 目标：在支持 Responses API + previous_response_id 的 provider 上，
 * 复用上一轮会话状态，避免每次都重发同一份 system prompt。
 *
 * 设计：
 * - 会话键：provider + model + target + voice
 * - 进程内热缓存 + SQLite 持久化双层存储
 * - 仅当 system 指纹完全一致时才复用 previous_response_id
 * - 空闲超时后自动失效，避免把陈旧上下文带进新一轮互动
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { llmSessions } from "../db/schema.js";

export interface TickSessionRecord {
  providerName: string;
  model: string;
  systemFingerprint: string;
  previousResponseId: string;
  updatedAtMs: number;
}

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const _sessions = new Map<string, TickSessionRecord>();

function isExpired(record: TickSessionRecord, nowMs: number): boolean {
  return nowMs - record.updatedAtMs > SESSION_IDLE_TTL_MS;
}

function deletePersistedSession(sessionKey: string): void {
  try {
    getDb().delete(llmSessions).where(eq(llmSessions.sessionKey, sessionKey)).run();
  } catch {
    // 测试/早期启动阶段 DB 可能尚未初始化 —— 忽略即可
  }
}

function loadPersistedSession(sessionKey: string): TickSessionRecord | null {
  try {
    const row = getDb().select().from(llmSessions).where(eq(llmSessions.sessionKey, sessionKey)).get();
    if (!row) return null;
    return {
      providerName: row.providerName,
      model: row.model,
      systemFingerprint: row.systemFingerprint,
      previousResponseId: row.previousResponseId,
      updatedAtMs: row.updatedAtMs,
    };
  } catch {
    return null;
  }
}

export function buildTickSessionKey(args: {
  providerName: string;
  model: string;
  target: string | null;
  voice: string;
}): string {
  return [args.providerName, args.model, args.target ?? "_no_target_", args.voice].join("::");
}

export function getReusableResponseId(args: {
  sessionKey: string;
  providerName: string;
  model: string;
  systemFingerprint: string;
  nowMs?: number;
}): string | null {
  const nowMs = args.nowMs ?? Date.now();
  let current = _sessions.get(args.sessionKey);
  if (!current) {
    current = loadPersistedSession(args.sessionKey) ?? undefined;
    if (current) _sessions.set(args.sessionKey, current);
  }
  if (!current) return null;

  const mismatched =
    current.providerName !== args.providerName ||
    current.model !== args.model ||
    current.systemFingerprint !== args.systemFingerprint;

  if (isExpired(current, nowMs) || mismatched) {
    _sessions.delete(args.sessionKey);
    deletePersistedSession(args.sessionKey);
    return null;
  }

  current.updatedAtMs = nowMs;
  return current.previousResponseId;
}

export function saveReusableResponseId(args: {
  sessionKey: string;
  providerName: string;
  model: string;
  systemFingerprint: string;
  previousResponseId: string;
  nowMs?: number;
}): void {
  const record: TickSessionRecord = {
    providerName: args.providerName,
    model: args.model,
    systemFingerprint: args.systemFingerprint,
    previousResponseId: args.previousResponseId,
    updatedAtMs: args.nowMs ?? Date.now(),
  };
  _sessions.set(args.sessionKey, record);

  try {
    getDb()
      .insert(llmSessions)
      .values({
        sessionKey: args.sessionKey,
        providerName: record.providerName,
        model: record.model,
        systemFingerprint: record.systemFingerprint,
        previousResponseId: record.previousResponseId,
        updatedAtMs: record.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: llmSessions.sessionKey,
        set: {
          providerName: record.providerName,
          model: record.model,
          systemFingerprint: record.systemFingerprint,
          previousResponseId: record.previousResponseId,
          updatedAtMs: record.updatedAtMs,
        },
      })
      .run();
  } catch {
    // DB 不可用时保留内存缓存，功能降级但不阻塞主路径
  }
}

export function clearTickSession(sessionKey: string): void {
  _sessions.delete(sessionKey);
  deletePersistedSession(sessionKey);
}

export function resetTickSessions(): void {
  _sessions.clear();
}
