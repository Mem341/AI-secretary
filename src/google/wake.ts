import type { Env } from "../env";
import { formatTime, MINUTE } from "../lib/time";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { Calendar } from "./calendar";
import { Gmail } from "./gmail";
import { seenLabel, startGmailWatch } from "./gmailPush";
import { connectLink, loadGrant, loadOwnerSettings, saveOwnerSettings } from "./oauth";
import { ensureGmailPush, type PushSetup, pubsubApiLink, setupGoogleWake } from "./pubsub";
import { applyEmailReminders } from "./reminders";
import { signalCalendar, TEST_PREFIX, shadowId } from "./signals";

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
 * «🔁 Перевірити»: every link of the reminder chain checked in order and said in plain words, then a real test —
 * a signal a few minutes ahead; when Google's email for it wakes the bot, the owner gets «✅ Тест пройдено».
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
  const has = (s: string) => grant.scope.includes(s);
  const missing = [
    !has("gmail.modify") && "пошта",
    !has("pubsub") && "сигнали від Google (Pub/Sub)",
    !has("calendar.app.created") && "календар сигналів",
  ].filter(Boolean);
  lines.push(missing.length ? `❌ <b>Дозволи Google:</b> бракує — ${missing.join(", ")}.` : `✅ <b>Дозволи Google</b>${grant.email ? ` (${esc(grant.email)})` : ""}`);
  if (missing.length) {
    lines.push("", "Одного «Enable» у Google Cloud мало: перепідключіть Google й поставте всі галочки, потім «Перевірити ще раз».");
    keyboard.push([{ text: "🔄 Перепідключити Google", url: await connectLink(env) }], retry);
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
    if (r.unseen) lines.push(`⚠️ <b>Листи-сигнали:</b> Google надіслав ${r.unseen}, але до мене вони не дійшли (мабуть, до цієї перевірки Pub/Sub ще не був налаштований). Тест нижче покаже, чи тепер доходять.`);
    else if (r.unread.length) lines.push(`⚠️ <b>Листи-сигнали:</b> не розпізнав — «${esc(r.unread[0]!.slice(0, 80))}».`);
    else if (r.spam) lines.push(`⚠️ <b>Листи-сигнали:</b> ${r.spam} у «Спамі» — позначте їх «Не спам».`);
    else lines.push(`✅ <b>Листи-сигнали за добу:</b> оброблено ${r.handled}`);
  } catch (err) {
    lines.push(`⚠️ Не зміг переглянути пошту: ${errText(err)}`);
  }

  if (sc) {
    // A real signal: starts in 5 minutes, Google's email for it 3 minutes before — so in about 2 minutes.
    const start = Math.ceil((now + 5 * MINUTE) / MINUTE) * MINUTE;
    try {
      await new Calendar(env, sc).putEvent({
        id: shadowId(`${TEST_PREFIX}${now}`),
        summary: "🧪 Тест нагадувань",
        status: "confirmed",
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(start + 5 * MINUTE).toISOString() },
        transparency: "transparent",
        visibility: "private",
        reminders: { useDefault: false, overrides: [{ method: "email", minutes: 3 }] },
        extendedProperties: { private: { aisFor: `${TEST_PREFIX}${now}` } },
      } as never);
      lines.push("", `🧪 <b>Тест запущено.</b> Близько ${formatTime(new Date(start - 3 * MINUTE))} Google надішле сигнал, і я напишу «✅ Тест пройдено». Якщо до ${formatTime(new Date(start + 2 * MINUTE))} нічого не прийде — натисніть «Перевірити ще раз», я скажу, де обірвалося.`);
    } catch (err) {
      lines.push("", `❌ Не зміг запустити тест: ${errText(err)}`);
    }
  }
  keyboard.push(retry);
  await send();
}
