// Registers the Telegram webhook (with the secret header) and the bot's command menu.
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... PUBLIC_URL=https://... npm run telegram:setup
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, PUBLIC_URL: publicUrl } = process.env;
if (!token || !secret || !publicUrl) {
  console.error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_URL");
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  console.log(`${method}: ok`);
}

await call("setWebhook", {
  url: `${publicUrl.replace(/\/$/, "")}/api/telegram`,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
await call("setMyCommands", {
  commands: [
    { command: "new", description: "Нова зустріч" },
    { command: "contacts", description: "Адресна книга" },
    { command: "settings", description: "Профіль і календар" },
    { command: "cancel", description: "Скасувати поточну дію" },
    { command: "help", description: "Що вміє бот" },
  ],
});
