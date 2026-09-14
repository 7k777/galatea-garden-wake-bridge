import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { JsonStore } from "./store.js";
import { TelegramGateway } from "./telegram.js";
import { buildListenerHtml } from "./listener-html.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

const token = required("TELEGRAM_BOT_TOKEN");
const pairCode = required("TELEGRAM_PAIR_CODE");
const dataDir = process.env.DATA_DIR ?? "/var/lib/cheng-telegram-bridge";
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "18131");
const mcpPath = process.env.MCP_PATH ?? "/mcp";
const pluginHandle = process.env.PLUGIN_HANDLE ?? "ChengLetter Bridge";
const leaseSeconds = Number(process.env.RESERVATION_LEASE_SECONDS ?? "120");
const store = new JsonStore(dataDir);
const telegram = new TelegramGateway(token, pairCode, store, Number(process.env.POLL_TIMEOUT_SECONDS ?? "25"));
const resourceUri = "ui://chengletter/telegram-listener-v1.html";

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "chengletter-bridge", version: "0.1.0" });
  registerAppResource(server, "chengletter-listener", resourceUri, {}, async () => ({ contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: buildListenerHtml(pluginHandle), _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }] }));

  server.registerTool("open_chengletter_listener", {
    title: "打开 ChengLetter Listener",
    description: "挂载澄的 Telegram 消息监听卡片。卡片默认暂停，必须由淇点击开始监听。",
    inputSchema: {}, outputSchema: { ready: z.boolean() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri }, "openai/outputTemplate": resourceUri },
  }, async () => ({ structuredContent: { ready: true }, content: [{ type: "text", text: "ChengLetter Listener 已挂载，等待淇开始监听。" }] }));

  server.registerTool("bridge_listener_sync", {
    title: "同步 Telegram 队列", description: "为 Listener 保留下一条待处理事件。",
    inputSchema: {}, outputSchema: { hasEvent: z.boolean(), eventId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async () => { const event = await store.reserveNext(leaseSeconds); return event ? { structuredContent: { hasEvent: true, eventId: event.id }, content: [], _meta: { event } } : { structuredContent: { hasEvent: false }, content: [] }; });

  server.registerTool("bridge_listener_delivered", {
    title: "确认消息已入会话", description: "将已保留事件标记为 host_sent。",
    inputSchema: { eventId: z.string().min(1) }, outputSchema: { delivered: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: { ui: { visibility: ["app"] } },
  }, async ({ eventId }) => { await store.markHostSent(eventId); return { structuredContent: { delivered: true }, content: [] }; });

  server.registerTool("bridge_listener_release", {
    title: "释放消息租约", description: "在 UI 送入失败时释放事件，以便重试。",
    inputSchema: { eventId: z.string().min(1) }, outputSchema: { released: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }, _meta: { ui: { visibility: ["app"] } },
  }, async ({ eventId }) => { await store.release(eventId); return { structuredContent: { released: true }, content: [] }; });

  server.registerTool("send_telegram_reply", {
    title: "回复 ChengLetter 消息",
    description: "把澄对某个已送入官方会话的事件回复回原 Telegram 私聊。reply target 由服务器按 eventId 绑定。",
    inputSchema: { eventId: z.string().min(1), text: z.string().min(1).max(4096) },
    outputSchema: { sent: z.boolean(), alreadySent: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, async ({ eventId, text }) => {
    const target = await store.getReplyTarget(eventId);
    if (target.completed) return { structuredContent: { sent: true, alreadySent: true }, content: [{ type: "text", text: "这条 Telegram 回复此前已经成功发送。" }] };
    await telegram.sendMessage(target.chatId, text, target.messageId);
    await store.markCompleted(eventId);
    return { structuredContent: { sent: true, alreadySent: false }, content: [{ type: "text", text: "已回复到 ChengLetterbot。" }] };
  });
  return server;
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.get("/health", async (_req, res) => { const state = await store.getSnapshot(); res.json({ ok: true, paired: Boolean(state.authorizedChatId), pending: state.events.filter((event) => event.status === "pending").length }); });
app.post(mcpPath, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get(mcpPath, (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
app.delete(mcpPath, (_req, res) => res.status(405).json({ error: "method_not_allowed" }));

const httpServer = app.listen(port, host, () => console.log(`chengletter_bridge_listening http://${host}:${port}${mcpPath}`));
void telegram.run();
function shutdown(): void { telegram.stop(); httpServer.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
