export type EventStatus = "pending" | "reserved" | "host_sent" | "completed";

export type BridgeEvent = {
  id: string;
  kind: "telegram_message" | "wake";
  source: "telegram" | "wakebridge";
  createdAt: string;
  visibleText: string;
  modelContext: string;
  telegramChatId: string;
  telegramMessageId?: number;
  status: EventStatus;
  reservedAt?: string;
  deliveredAt?: string;
  completedAt?: string;
  retryCount: number;
};

export type BridgeState = {
  version: 1;
  telegramOffset: number;
  authorizedChatId?: string;
  events: BridgeEvent[];
};
