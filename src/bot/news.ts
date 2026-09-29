import { CURRENT_VERSION, RELEASES } from "../changelog";
import type { Env } from "../env";
import { connectLink, loadGrant, loadOwnerSettings, missingScopes, saveOwnerSettings } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";

/**
 * «What is new» once after a new version is deployed: the releases since the one the owner last saw (its number is kept
 * with the owner's settings in the pinned message — no database), and what the owner has to do for them, checked live
 * (Google permissions missing, Google not waking the bot yet). A fresh install starts quietly at the current version.
 */
export async function announceUpdate(env: Env): Promise<boolean> {
  const settings = await loadOwnerSettings(env).catch(() => null);
  if (!settings || (settings.v ?? 0) >= CURRENT_VERSION) return false;
  const grant = await loadGrant(env).catch(() => null);
  const seen = settings.v;
  await saveOwnerSettings(env, { ...settings, v: CURRENT_VERSION });
  // A new owner (nothing set up yet) gets the greeting, not a list of changes.
  if (seen === undefined && !grant) return false;

  const releases = RELEASES.filter((r) => r.v > (seen ?? CURRENT_VERSION - 1)).slice(0, 3);
  const added = releases.flatMap((r) => r.added ?? []);
  const changed = releases.flatMap((r) => r.changed ?? []);
  const lines = ["🆕 <b>Бот оновлено</b>"];
  if (added.length) lines.push("", "<b>Додано:</b>", ...added.map((a) => `• ${esc(a)}`));
  if (changed.length) lines.push("", "<b>Змінено:</b>", ...changed.map((c) => `• ${esc(c)}`));

  const todo: string[] = [];
  const keyboard: InlineKeyboard = [];
  const missing = grant ? missingScopes(grant.scope) : [];
  if (missing.length) {
    todo.push("Перепідключіть Google й поставте «Вибрати все» — інакше не працюватиме: " + missing.map((m) => m.split(" — ")[0]).join(", "));
    keyboard.push([{ text: "🔄 Підключити Google з усіма галочками", url: await connectLink(env) }]);
  } else if (grant && settings.p !== "ok") {
    todo.push("Натисніть «Перевірити» — я налаштую нагадування й надішлю тестове");
    keyboard.push([{ text: "🔎 Перевірити нагадування", callback_data: "set:wake" }]);
  }
  lines.push("", todo.length ? `⚠️ <b>Що зробити:</b>\n${todo.map((t) => `• ${esc(t)}`).join("\n")}` : "✅ Нічого робити не треба — усе вже працює.");
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, lines.join("\n"), keyboard.length ? { keyboard } : {});
  return true;
}
