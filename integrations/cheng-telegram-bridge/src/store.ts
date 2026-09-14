import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BridgeEvent, BridgeState } from "./types.js";

const INITIAL_STATE: BridgeState = { version: 1, telegramOffset: 0, events: [] };

export class JsonStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "state.json");
  }

  private async read(): Promise<BridgeState> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as BridgeState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(INITIAL_STATE);
      throw error;
    }
  }

  private async write(state: BridgeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private transact<T>(operation: (state: BridgeState) => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      const state = await this.read();
      const value = await operation(state);
      await this.write(state);
      return value;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  getSnapshot(): Promise<BridgeState> {
    return this.queue.then(() => this.read());
  }

  setAuthorizedChatId(chatId: string): Promise<void> {
    return this.transact((state) => { state.authorizedChatId = chatId; });
  }

  advanceTelegramOffset(offset: number): Promise<void> {
    return this.transact((state) => { state.telegramOffset = Math.max(state.telegramOffset, offset); });
  }

  enqueue(event: BridgeEvent): Promise<boolean> {
    return this.transact((state) => {
      if (state.events.some((item) => item.id === event.id)) return false;
      state.events.push(event);
      return true;
    });
  }

  reserveNext(leaseSeconds: number): Promise<BridgeEvent | null> {
    return this.transact((state) => {
      const now = Date.now();
      for (const event of state.events) {
        if (event.status === "reserved" && event.reservedAt) {
          const age = now - Date.parse(event.reservedAt);
          if (age >= leaseSeconds * 1000) {
            event.status = "pending";
            event.reservedAt = undefined;
            event.retryCount += 1;
          }
        }
      }
      const event = state.events.find((item) => item.status === "pending");
      if (!event) return null;
      event.status = "reserved";
      event.reservedAt = new Date(now).toISOString();
      return structuredClone(event);
    });
  }

  markHostSent(eventId: string): Promise<void> {
    return this.transact((state) => {
      const event = state.events.find((item) => item.id === eventId);
      if (!event) throw new Error("unknown_event");
      if (event.status === "host_sent" || event.status === "completed") return;
      if (event.status !== "reserved") throw new Error("event_not_reserved");
      event.status = "host_sent";
      event.deliveredAt = new Date().toISOString();
    });
  }

  release(eventId: string): Promise<void> {
    return this.transact((state) => {
      const event = state.events.find((item) => item.id === eventId);
      if (!event || event.status !== "reserved") return;
      event.status = "pending";
      event.reservedAt = undefined;
      event.retryCount += 1;
    });
  }

  getReplyTarget(eventId: string): Promise<{ chatId: string; messageId?: number; completed: boolean }> {
    return this.queue.then(async () => {
      const state = await this.read();
      const event = state.events.find((item) => item.id === eventId);
      if (!event) throw new Error("unknown_event");
      if (event.status !== "host_sent" && event.status !== "completed") throw new Error("event_not_host_sent");
      return { chatId: event.telegramChatId, messageId: event.telegramMessageId, completed: event.status === "completed" };
    });
  }

  markCompleted(eventId: string): Promise<void> {
    return this.transact((state) => {
      const event = state.events.find((item) => item.id === eventId);
      if (!event) throw new Error("unknown_event");
      event.status = "completed";
      event.completedAt ??= new Date().toISOString();
    });
  }
}
