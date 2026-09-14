# ChengLetter Telegram ↔ ChatGPT bridge

Private integration for `@ChengLetter_bot`. It keeps Telegram ingress/outbound routing on the server and uses an MCP App Listener (`ui/update-model-context` followed by `ui/message`) to enter the current official ChatGPT conversation.

## Security invariants

- The Telegram token and pairing code stay in the root-only VPS environment file.
- The first owner must pair with `/pair <code>` in a private chat.
- After pairing, only that Telegram chat can enqueue messages.
- Outbound replies accept an `eventId`; the server derives the Telegram chat target and never accepts arbitrary chat IDs from the model.
- Queue state is durable and delivery is idempotent.

## First milestone

1. Start the service and pair the existing bot.
2. Connect the HTTPS MCP endpoint as a custom plugin.
3. Call `open_chengletter_listener` and click “开始监听”.
4. Send `hello` to Telegram.
5. Confirm the message enters the official conversation and `send_telegram_reply` mirrors the answer back.

Wake production is intentionally added only after this round trip passes.

The listener protocol follows the MIT-licensed reference architecture at `wynsyl1014/mcp-app-message-bridge` and the MCP Apps/OpenAI plugin UI specifications.
