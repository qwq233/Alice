/**
 * mtcute Telegram 客户端初始化。
 */

import { Dispatcher } from "@mtcute/dispatcher";
import { TelegramClient } from "@mtcute/node";
import type { Config } from "../config.js";

let _client: TelegramClient | null = null;
let _dispatcher: Dispatcher | null = null;

/**
 * 创建并返回 TelegramClient 实例。
 * session 文件默认存储为 SQLite (mtcute 内置)。
 */
export function createClient(config: Config): TelegramClient {
  if (_client) return _client;

  _client = new TelegramClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    storage: "alice.session",
  });

  return _client;
}

/**
 * 获取当前 client 实例（必须先 createClient）。
 */
export function getClient(): TelegramClient {
  if (!_client) throw new Error("TelegramClient not initialized. Call createClient() first.");
  return _client;
}

/**
 * 创建并绑定 Dispatcher 到 client。
 */
export function createDispatcher(client: TelegramClient): Dispatcher {
  if (_dispatcher) return _dispatcher;
  _dispatcher = Dispatcher.for(client);
  return _dispatcher;
}

/**
 * 获取当前 Dispatcher 实例。
 */
export function getDispatcher(): Dispatcher {
  if (!_dispatcher) throw new Error("Dispatcher not initialized. Call createDispatcher() first.");
  return _dispatcher;
}

/**
 * 启动客户端（登录 / 恢复 session）。
 */
export async function startClient(client: TelegramClient, phone: string): Promise<void> {
  await client.start({
    phone: () => Promise.resolve(phone),
    code: () => client.input("Enter the code: "),
    password: () => client.input("Enter 2FA password: "),
  });
}

/**
 * 优雅关闭。
 * try/catch: dispatcher.destroy() 可能已关闭底层连接，
 * 后续 client.destroy() 的 session save 会抛 "database connection not open"。
 * 此处静默忽略——shutdown 路径上不值得因为 session save 失败而阻塞。
 */
export async function destroyClient(): Promise<void> {
  try {
    if (_dispatcher) {
      await _dispatcher.destroy();
      _dispatcher = null;
    }
  } catch {
    /* shutdown — 静默 */
  }
  try {
    if (_client) {
      await _client.destroy();
      _client = null;
    }
  } catch {
    /* shutdown — 静默 */
  }
}
