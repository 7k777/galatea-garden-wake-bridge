import type { JsonStore } from "./store.js";
import type { BridgeEvent } from "./types.js";

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
  date: number;
};

type TelegramUpdate = { update_id: number; message?: TelegramMessage };

export class TelegramGateway {
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly pairCode: string,
    private readonly store: JsonStore,
    private readonly pollTimeoutSeconds: number,
  ) {}

  private async api<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((this.pollTimeoutSeconds + 10) * 1000),
    });
    const data = await response.json() as { ok: boolean; result: T; description?: string };
    if (!response.ok || !data.ok) throw new Error(`telegram_${method}: ${data.description ?? response.status}`);
    return data.result;
  }

  async sendMessage(chatId: string, text: string, replyTo?: number): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, 4096),
      disable_web_page_preview: true,
    };
    if (replyTo) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    await this.api("sendMessage", body);
  }

  private async handleMessage(update: TelegramUpdate, message: TelegramMessage): Promise<void> {
    if (message.chat.type !== "private" || !message.text) return;
    const chatId = String(message.chat.id);
    const text = message.text.trim();
    const state = await this.store.getSnapshot();

    if (!state.authorizedChatId) {
      if (text === `/pair ${this.pairCode}`) {
        await this.store.setAuthorizedChatId(chatId);
        await this.sendMessage(chatId, "配对完成啦。现在可以直接给澄发消息 ♡", message.message_id);
      }
      return;
    }
    if (state.authorizedChatId !== chatId) return;
    if (text === "/start") {
      await this.sendMessage(chatId, "我在。Listener 在线时，消息会进入澄的官方会话。", message.message_id);
      return;
    }
    if (text.startsWith("/pair ")) {
      await this.sendMessage(chatId, "这只 ChengLetterbot 已经和淇配对。", message.message_id);
      return;
    }

    const eventId = `tg:${update.update_id}`;
    const event: BridgeEvent = {
      id: eventId,
      kind: "telegram_message",
      source: "telegram",
      createdAt: new Date(message.date * 1000).toISOString(),
      visibleText: text.slice(0, 3500),
      modelContext: [
        "这是淇通过 ChengLetterbot 发来的当前前景消息。",
        "请按照当前官方会话中的连续性正常回应淇。",
        "完成回答时必须调用 send_telegram_reply，把同一份自然回复送回 Telegram。",
        `eventId=${eventId}`,
      ].join("\n"),
      telegramChatId: chatId,
      telegramMessageId: message.message_id,
      status: "pending",
      retryCount: 0,
    };
    if (await this.store.enqueue(event)) {
      await this.sendMessage(chatId, "收到啦，正在敲澄的门…", message.message_id);
    }
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const state = await this.store.getSnapshot();
        const updates = await this.api<TelegramUpdate[]>("getUpdates", {
          offset: state.telegramOffset,
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ["message"],
        });
        for (const update of updates) {
          try {
            if (update.message) await this.handleMessage(update, update.message);
          } finally {
            await this.store.advanceTelegramOffset(update.update_id + 1);
          }
        }
      } catch (error) {
        console.error("telegram_poll_error", error instanceof Error ? error.message : String(error));
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  stop(): void { this.stopped = true; }
}
