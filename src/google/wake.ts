import type { Env } from "../env";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { Calendar } from "./calendar";
import { Gmail } from "./gmail";
import { seenLabel, startGmailWatch } from "./gmailPush";
import { connectLink, loadGrant, loadOwnerSettings, missingScopes, saveOwnerSettings } from "./oauth";
import { ensureGmailPush, type PushSetup, pubsubApiLink, setupGoogleWake } from "./pubsub";
import { applyEmailReminders } from "./reminders";
import { signalCalendar } from "./signals";

export { setupGoogleWake };

/** What to tell the owner about Google as the bot's clock, and the one button that fixes it. */
export async function wakeAdvice(env: Env, result: PushSetup): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const retry = { text: "🔁 Перевірити ще раз", callback_data: "set:wake" };
  if (result.ok) return { text: "✅ Google будить мене одразу, як приходить сигнал.", keyboard: [] };
  switch (result.reason) {
    case "no_scope":
      return {
        text: "❌ У Google-підключенні немає нових дозволів. Одного «Enable» у Google Cloud мало: натисніть «Перепідключити Google» і поставте всі галочки.",
        keyboard: [[{ text: "🔄 Перепідключити Google", url: await connectLink(env) }]],
      };
    case "api_disabled":
      return {
        text: "❌ Cloud Pub/Sub API вимкнено саме в проєкті вашого Google-клієнта (кнопка нижче → Enable), потім «Перевірити ще раз».",
        keyboard: [[{ text: "🔗 Увімкнути Cloud Pub/Sub API", url: pubsubApiLink(env) }], [retry]],
      };
    case "no_project":
      return { text: "❌ Не бачу проєкту Google Cloud: завантажте JSON Google-клієнта заново й покладіть його в GOOGLE_CLIENT_JSON.", keyboard: [] };
    default:
      return { text: `❌ Google відмовив: ${esc((result.detail ?? "").slice(0, 300))}`, keyboard: [[retry]] };
  }
}

const errText = (err: unknown) => esc((err instanceof Error ? err.message : String(err)).slice(0, 300));

/** Reminder emails from Google in the last day: in the inbox (not handled), in Trash (handled), in Spam. */
async function recentSignals(gmail: Gmail): Promise<{ handled: number; unseen: number; unread: string[]; spam: number }> {
  const q = "from:calendar-notification@google.com newer_than:1d";
  const [inbox, trash, spam] = await Promise.all([gmail.search(`${q} in:inbox`, 20), gmail.search(`${q} in:trash`, 50), gmail.search(`${q} in:spam`, 20)]);
  const label = await seenLabel(gmail);
  let unseen = 0;
  const unread: string[] = [];
  for (const id of inbox) {
    const m = await gmail.call<{ labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } }>(
      `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject`,
    );
    // Not marked seen: the push never reached me. Marked but left in the inbox: I did not recognise it.
    if (!m.labelIds?.includes(label)) unseen++;
    else unread.push(m.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ?? "");
  }
  return { handled: trash.length, unseen, unread, spam: spam.length };
}

/**
 * «🔁 Налаштувати» (shown while reminders are not working): every link of the reminder chain set up and checked in
 * order, said in plain words.
 */
export async function reportWake(env: Env, chatId: number, now = Date.now()): Promise<void> {
  const tg = new Telegram(env);
  const lines = ["🔎 <b>Перевірка нагадувань</b>", ""];
  const keyboard: InlineKeyboard = [];
  const send = () => tg.send(chatId, lines.join("\n"), keyboard.length ? { keyboard } : {});
  const retry = [{ text: "🔁 Перевірити ще раз", callback_data: "set:wake" }];

  const grant = await loadGrant(env);
  if (!grant) {
    lines.push("❌ Google не підключено.");
    keyboard.push([{ text: "🔗 Підключити Google", url: await connectLink(env) }]);
    return void (await send());
  }
  // Memory (Drive) is not part of reminders.
  const missing = missingScopes(grant.scope).filter((m) => !m.startsWith("памʼять"));
  lines.push(missing.length ? "❌ <b>Дозволи Google:</b> на екрані Google не поставлено галочки:" : `✅ <b>Дозволи Google</b>${grant.email ? ` (${esc(grant.email)})` : ""}`);
  if (missing.length) {
    lines.push(...missing.map((m) => `• ${esc(m)}`));
    lines.push(
      "",
      "Google показує кожен дозвіл окремою галочкою, і нові стоять <b>невідмічені</b>. Натисніть кнопку → оберіть акаунт → на екрані з дозволами поставте <b>«Вибрати все» (Select all)</b> → «Продовжити». Потім «Перевірити ще раз».",
    );
    keyboard.push([{ text: "🔄 Підключити з усіма галочками", url: await connectLink(env) }], retry);
    return void (await send());
  }

  const push = await ensureGmailPush(env);
  const settings = await loadOwnerSettings(env);
  const p = push.ok ? "ok" : push.reason;
  if (settings.p !== p) await saveOwnerSettings(env, { ...settings, p });
  if (!push.ok) {
    const advice = await wakeAdvice(env, push);
    lines.push(advice.text);
    keyboard.push(...advice.keyboard);
    return void (await send());
  }
  lines.push("✅ <b>Pub/Sub:</b> топік і підписка є, Google пушить на цей бот");

  try {
    await startGmailWatch(env);
    lines.push("✅ <b>Пошта під наглядом:</b> лист від Google одразу будить мене");
  } catch (err) {
    lines.push(`❌ <b>Пошта:</b> Google не дав стежити за поштою — ${errText(err)}`);
    keyboard.push(retry);
    return void (await send());
  }

  let sc: string | null = null;
  try {
    sc = await signalCalendar(env);
    const writes = await applyEmailReminders(env, undefined, now);
    const shadows = sc
      ? (await new Calendar(env, sc).listEvents({ singleEvents: "true", timeMin: new Date(now).toISOString(), timeMax: new Date(now + 8 * 86_400_000).toISOString(), maxResults: "250" })).items
      : [];
    lines.push(`✅ <b>Календар «AI-secretary · сигнали»:</b> сигналів на тиждень — ${shadows.length}${writes ? ` (оновив ${writes})` : ""}`);
  } catch (err) {
    lines.push(`❌ <b>Календар сигналів:</b> ${errText(err)}`);
  }

  try {
    const r = await recentSignals(new Gmail(env));
    if (r.unseen) lines.push(`⚠️ <b>Листи-сигнали:</b> Google надіслав ${r.unseen}, але до мене вони не дійшли (мабуть, до цієї перевірки Pub/Sub ще не був налаштований). Тепер Pub/Sub налаштовано — наступні дійдуть.`);
    else if (r.unread.length) lines.push(`⚠️ <b>Листи-сигнали:</b> не розпізнав — «${esc(r.unread[0]!.slice(0, 80))}».`);
    else if (r.spam) lines.push(`⚠️ <b>Листи-сигнали:</b> ${r.spam} у «Спамі» — позначте їх «Не спам».`);
    else lines.push(`✅ <b>Листи-сигнали за добу:</b> оброблено ${r.handled}`);
  } catch (err) {
    lines.push(`⚠️ Не зміг переглянути пошту: ${errText(err)}`);
  }

  lines.push("", sc ? "✅ <b>Усе налаштовано.</b> Нагадування приходитимуть самі в обрані хвилини." : "⚠️ Календар сигналів не створено — перепідключіть Google з усіма галочками.");
  keyboard.push(retry);
  await send();
}
