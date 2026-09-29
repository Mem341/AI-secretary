import { bitrixConfigured, type Env, zoomConfigured } from "../env";
import { gmailPushEndpoint } from "../google/gmailPush";
import { connectLink, hasGmailScope, hasGoogleAuth, loadOwnerSettings, type OwnerSettings, saveOwnerSettings } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { clearMemory, MEMORY_CHOICES, memoryStatus, SEND } from "../agent/memory";
import { wakeReady } from "../google/pubsub";
import { refreshCommands } from "./commands";
import { applyEmailReminders, reminderChannels } from "../google/reminders";
import { DIGEST_BLOCKS, DIGEST_TIMES, type DigestBlock, digestByGoogle, loadDigestChoice, timeText } from "../google/digest";
import { integrationSource } from "../integrations";
import { disconnect, INTEGRATION_NAMES, type Integration, startConnect } from "./connect";
import type { User } from "./owner";

/**
 * /settings: what is connected, what can be connected, and the owner's own choices (when to remind, the morning
 * list) — changed with buttons, saved in the pinned Google message. No database.
 */

/** Reminder choices offered as buttons, in minutes before a meeting. */
export const REMINDER_CHOICES = [60, 30, 15, 10, 5];

/** When to remind: the owner's choice, else REMINDER_MINUTES (30 and 10). Largest first; [] = off. */
export async function reminderMarks(env: Env): Promise<number[]> {
  const s = await loadOwnerSettings(env).catch((): OwnerSettings => ({}));
  return [...(s.r ?? env.REMINDER_MINUTES)].sort((a, b) => b - a);
}

export async function digestEnabled(env: Env): Promise<boolean> {
  const s = await loadOwnerSettings(env).catch((): OwnerSettings => ({}));
  return s.d ?? true;
}

function marksText(marks: number[]): string {
  if (!marks.length) return "вимкнено";
  // "за 30 і 10 хв", "за 1 год, 30 хв і 10 хв"
  const hour = marks.includes(60);
  const list = marks.map((m) => (m === 60 ? "1 год" : hour ? `${m} хв` : String(m)));
  const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} і ${list.at(-1)}` : list[0];
  return `за ${joined}${hour ? "" : " хв"} до зустрічі`;
}

const line = (ok: boolean, text: string) => `${ok ? "✅" : "➕"} ${text}`;

async function mainView(env: Env, user: User): Promise<{ html: string; keyboard: InlineKeyboard }> {
  const google = await hasGoogleAuth(env);
  const gmail = google && (await hasGmailScope(env));
  const marks = await reminderMarks(env);
  const digest = await digestEnabled(env);
  const name = user.full_name ? `<b>${esc(user.full_name)}</b>` : "<b>Власник</b>";

  const connected: string[] = [];
  const available: string[] = [];
  (google ? connected : available).push(line(google, "Google Calendar — зустрічі, розклад, запрошення"));
  if (google) (gmail ? connected : available).push(line(gmail, gmail ? "Gmail — пошта" : "Gmail — перепідключіть Google й дозвольте пошту"));
  else available.push(line(false, "Gmail — пошта (разом із Google)"));
  connected.push(line(true, "Голосові повідомлення"));
  const awake = gmail && (await wakeReady(env));
  (awake ? connected : available).push(line(awake, awake ? "Миттєві сповіщення про нові листи й нагадування" : "Сповіщення про листи й нагадування — /settings → ⏰"));
  (bitrixConfigured(env) ? connected : available).push(line(bitrixConfigured(env), "Bitrix24 — задачі (/bitrix)"));
  (zoomConfigured(env) ? connected : available).push(line(zoomConfigured(env), "Zoom — зустрічі в Zoom"));

  const html = [
    "⚙️ <b>Налаштування</b>",
    "",
    `👤 ${name}${user.email ? `\n📧 ${esc(user.email)}` : ""}`,
    "",
    "<b>Підключено</b>",
    ...connected,
    ...(available.length ? ["", "<b>Можна підключити</b>", ...available] : []),
    "",
    "<b>Сповіщення</b>",
    `⏰ Нагадування: ${marksText(marks)}`,
    `☀️ Ранковий звіт: ${digest ? `щодня о ${timeText((await loadDigestChoice(env)).time)}` : "вимкнено"}`,
    "🔔 Нові запрошення, зміни в календарі й відповіді гостей — одразу",
  ].join("\n");

  const keyboard: InlineKeyboard = [];
  if (google) {
    keyboard.push([
      { text: "⏰ Нагадування", callback_data: "set:rem" },
      { text: "☀️ Ранковий звіт", callback_data: "set:dg" },
    ]);
    keyboard.push([{ text: "🧠 Памʼять", callback_data: "set:mem" }]);
  }
  keyboard.push([{ text: google ? "🔄 Перепідключити Google" : "🔗 Підключити Google", url: await connectLink(env) }]);
  // Bitrix24 and Zoom: connected right here (the bot asks for the key); set by a deployment variable — nothing to do.
  const integrationButtons = (["bitrix", "zoom"] as Integration[]).flatMap((w) => {
    const source = integrationSource(env, w);
    if (source === "variable") return [];
    return source === "settings"
      ? [{ text: `❌ Відключити ${INTEGRATION_NAMES[w]}`, callback_data: `set:off:${w}` }]
      : [{ text: `🔗 Підключити ${INTEGRATION_NAMES[w]}`, callback_data: `set:on:${w}` }];
  });
  if (integrationButtons.length) keyboard.push(integrationButtons);
  // Only for an own Pub/Sub topic (GMAIL_PUBSUB_TOPIC); otherwise the bot sets the push up itself.
  if (env.GMAIL_PUBSUB_TOPIC && gmail) keyboard.push([{ text: "📧 Адреса для сповіщень про листи", callback_data: "set:mailpush" }]);
  return { html, keyboard };
}

async function memoryView(env: Env, confirmClear = false): Promise<{ html: string; keyboard: InlineKeyboard }> {
  const st = await memoryStatus(env);
  const google = await hasGoogleAuth(env);
  const lines = [
    "🧠 <b>Памʼять</b>",
    "",
    "<b>Як це працює</b>",
    `• Одна розмова на все — календар, пошта, задачі. Я памʼятаю останні <b>${st.limit}</b> питань-відповідей; коли приходить нове, найстаріше видаляється — більше ${st.limit} не буває.`,
    `• У кожну відповідь беру останні ${SEND} як живий діалог: якщо я щось спитав — просто відповідайте, я продовжу ту саму дію.`,
    "• Вже виконане не повторюю. Видаляю лише те, що ви просите в поточному повідомленні.",
    "• Важливе — хто є хто, email, ваші звички — записую в <b>нотатку фактів</b>. Вона не зникає разом зі старими повідомленнями. Можна сказати: «запамʼятай, що …» або «забудь, що …».",
    "• Усе лежить у прихованій папці застосунку на вашому Google Drive: її не видно в Drive, доступ маєте лише ви й бот.",
    "• /reset — почати розмову заново (факти лишаються).",
    "",
    `<b>Зараз:</b> ${st.messages} питань-відповідей · ${st.facts.length} фактів`,
  ];
  if (!st.persistent) {
    lines.push(
      "",
      st.error && /drive api|accessNotConfigured|has not been used/i.test(st.error)
        ? "⚠️ Памʼять поки тимчасова: у вашому проєкті Google Cloud увімкніть <b>Google Drive API</b>."
        : google
          ? "⚠️ Памʼять поки тимчасова (зникає, коли бот перезапускається). Перепідключіть Google й дозвольте доступ — і вона стане постійною."
          : "⚠️ Памʼять поки тимчасова: підключіть Google, щоб вона зберігалась.",
    );
  }
  const size = (n: number) => ({ text: `${st.limit === n ? "✅" : "▫️"} ${n}`, callback_data: `set:mem:${n}` });
  const keyboard: InlineKeyboard = [
    MEMORY_CHOICES.map(size),
    [
      { text: "📄 Що я памʼятаю", callback_data: "set:mem:facts" },
      confirmClear ? { text: "⚠️ Так, очистити все", callback_data: "set:mem:clear!" } : { text: "🧹 Очистити", callback_data: "set:mem:clear" },
    ],
  ];
  if (!st.persistent && google) keyboard.push([{ text: "🔄 Перепідключити Google", url: await connectLink(env) }]);
  keyboard.push([{ text: "⬅️ Готово", callback_data: "set:back" }]);
  return { html: lines.join("\n"), keyboard };
}

async function remindersView(env: Env): Promise<{ html: string; keyboard: InlineKeyboard }> {
  const marks = await reminderMarks(env);
  const awake = await wakeReady(env);
  const ch = await reminderChannels(env);
  const button = (m: number) => ({ text: `${marks.includes(m) ? "✅" : "▫️"} ${m === 60 ? "1 год" : `${m} хв`}`, callback_data: `set:r:${m}` });
  return {
    html: [
      "⏰ <b>Нагадування про зустрічі</b>",
      "",
      "<b>Коли:</b> оберіть один чи кілька варіантів — натисніть ще раз, щоб прибрати.",
      `Зараз: ${marksText(marks)}`,
      "",
      "<b>Куди:</b>",
      `${ch.t ? "✅" : "▫️"} Telegram — повідомлення від мене`,
      `${ch.c ? "✅" : "▫️"} Google Calendar — сповіщення календаря на телефоні й компʼютері`,
      "",
      ch.t && !awake
        ? "⚠️ <b>Telegram-нагадування ще не налаштовані.</b> Натисніть «🔁 Перевірити» — я перевірю кожен крок, налаштую все сам і надішлю тестове нагадування."
        : "<i>Як це працює: на кожен обраний час ставлю сповіщення Google Calendar на вашу зустріч, а для Telegram — сигнал у моєму окремому календарі «AI-secretary · сигнали». У потрібну хвилину Google будить мене — і я пишу вам сюди. Ні cron, ні сторонніх сервісів.</i>",
    ].join("\n"),
    keyboard: [
      REMINDER_CHOICES.slice(0, 3).map(button),
      REMINDER_CHOICES.slice(3).map(button),
      [
        { text: "🔕 Не нагадувати", callback_data: "set:r:off" },
        { text: "⬅️ Готово", callback_data: "set:back" },
      ],
      [
        { text: `${ch.t ? "✅" : "▫️"} Telegram`, callback_data: "set:ch:t" },
        { text: `${ch.c ? "✅" : "▫️"} Google Calendar`, callback_data: "set:ch:c" },
      ],
      [{ text: "🔁 Перевірити й надіслати тест", callback_data: "set:wake" }],
    ],
  };
}

async function digestView(env: Env): Promise<{ html: string; keyboard: InlineKeyboard }> {
  const c = await loadDigestChoice(env);
  const byGoogle = await digestByGoogle(env);
  const tick = (on: boolean) => (on ? "✅" : "▫️");
  const html = [
    "☀️ <b>Ранковий звіт</b>",
    "",
    c.on ? `Щодня о <b>${timeText(c.time)}</b>.` : "Зараз <b>вимкнено</b>.",
    "",
    "<b>Що в ньому:</b>",
    "✅ 📅 Зустрічі на сьогодні — учасники, посилання, перетини, вільні вікна",
    ...(Object.keys(DIGEST_BLOCKS) as DigestBlock[]).map((b) => `${tick(c.blocks.includes(b))} ${DIGEST_BLOCKS[b]}`),
    "",
    "<i>Натисніть час або пункт, щоб змінити.</i>",
    ...(c.on && !byGoogle
      ? ["", "⚠️ Щоб звіт приходив у ваш час, увімкніть сигнали від Google: ⏰ Нагадування → «Перевірити». Поки що — щоранку о 7:45."]
      : []),
  ].join("\n");
  const times = DIGEST_TIMES.map((t) => ({ text: `${c.time === t ? "✅" : ""}${timeText(t)}`, callback_data: `set:dg:t:${t}` }));
  const blocks = (Object.keys(DIGEST_BLOCKS) as DigestBlock[]).map((b) => ({ text: `${tick(c.blocks.includes(b))} ${DIGEST_BLOCKS[b]}`, callback_data: `set:dg:b:${b}` }));
  return {
    html,
    keyboard: [
      times.slice(0, 3),
      times.slice(3),
      ...[0, 2, 4].map((i) => blocks.slice(i, i + 2)),
      [
        { text: "👀 Показати зараз", callback_data: "set:dg:now" },
        { text: c.on ? "🔕 Вимкнути звіт" : "🔔 Увімкнути звіт", callback_data: "set:digest" },
      ],
      [{ text: "⬅️ Готово", callback_data: "set:back" }],
    ],
  };
}

/** /settings */
export async function showSettings(env: Env, user: User): Promise<void> {
  await refreshCommands(env);
  const view = await mainView(env, user);
  await new Telegram(env).send(user.tg_id, view.html, { keyboard: view.keyboard });
}

/** A button under the settings message ("set:…"): handled right here, no AI. */
export async function handleSettingsButton(env: Env, user: User, data: string, callbackId: string, messageId: number): Promise<void> {
  const tg = new Telegram(env);
  const answer = (text?: string) => tg.answerCallback(callbackId, text).catch(() => undefined);
  const show = async (view: { html: string; keyboard: InlineKeyboard }) => tg.edit(user.tg_id, messageId, view.html, view.keyboard);

  if (data === "set:mailpush") {
    await answer();
    await tg.send(
      user.tg_id,
      `Адреса push-підписки Pub/Sub для сповіщень про нові листи (секретна, нікому не показуйте):\n<code>${esc(gmailPushEndpoint(env))}</code>`,
    );
    return;
  }
  const connect = /^set:(on|off):(bitrix|zoom)$/.exec(data);
  if (connect) {
    const what = connect[2] as Integration;
    if (connect[1] === "on") {
      await answer();
      await startConnect(env, user.tg_id, what);
      return;
    }
    await disconnect(env, what);
    await refreshCommands(env);
    await answer(`${INTEGRATION_NAMES[what]} відключено`);
    return show(await mainView(env, user));
  }
  if (data === "set:mem" || data.startsWith("set:mem:")) {
    const arg = data.slice("set:mem:".length);
    if (data === "set:mem") {
      await answer();
      return show(await memoryView(env));
    }
    if (arg === "facts") {
      await answer();
      const st = await memoryStatus(env);
      await tg.send(
        user.tg_id,
        st.facts.length
          ? `🧠 <b>Що я памʼятаю</b>\n\n${st.facts.map((f) => `• ${esc(f)}`).join("\n")}\n\n<i>Виправити: «забудь, що …» або «запамʼятай, що …».</i>`
          : "🧠 Поки що фактів немає. Скажіть «запамʼятай, що …» — і я збережу.",
      );
      return;
    }
    if (arg === "clear") {
      await answer();
      return show(await memoryView(env, true));
    }
    if (arg === "clear!") {
      await clearMemory(env);
      await answer("Памʼять очищено");
      return show(await memoryView(env));
    }
    const n = Number(arg);
    if (MEMORY_CHOICES.includes(n)) {
      await saveOwnerSettings(env, { ...(await loadOwnerSettings(env)), m: n });
      await answer(`Памʼятаю останні ${n} питань-відповідей`);
      return show(await memoryView(env));
    }
    await answer();
    return;
  }
  if (data === "set:wake") {
    await answer("Перевіряю…");
    await env.jobs.send({ type: "wake", chatId: user.tg_id });
    return;
  }
  if (data === "set:back") {
    await answer();
    return show(await mainView(env, user));
  }
  if (!(await hasGoogleAuth(env))) {
    await answer("Спершу підключіть Google");
    return;
  }
  const settings = await loadOwnerSettings(env);
  if (data === "set:rem") {
    await answer();
    return show(await remindersView(env));
  }
  if (data === "set:dg") {
    await answer();
    return show(await digestView(env));
  }
  if (data === "set:dg:now") {
    await answer("Збираю звіт…");
    await env.jobs.send({ type: "digest", chatId: user.tg_id });
    return;
  }
  if (data === "set:digest" || data.startsWith("set:dg:")) {
    const c = await loadDigestChoice(env);
    const [, , what, value] = data.split(":");
    if (data === "set:digest") settings.d = !c.on;
    else if (what === "t" && DIGEST_TIMES.includes(Number(value))) settings.dg = { ...settings.dg, t: Number(value) };
    else if (what === "b" && value && value in DIGEST_BLOCKS) {
      const b = value as DigestBlock;
      settings.dg = { ...settings.dg, b: c.blocks.includes(b) ? c.blocks.filter((x) => x !== b) : [...c.blocks, b] };
    }
    await saveOwnerSettings(env, settings);
    await answer(data === "set:digest" ? (settings.d ? "Ранковий звіт увімкнено" : "Ранковий звіт вимкнено") : "Збережено");
    // The report's signal moves to the new time.
    await applyEmailReminders(env).catch(() => 0);
    return show(await digestView(env));
  }
  if (data === "set:ch:t" || data === "set:ch:c") {
    const ch = await reminderChannels(env);
    const which = data.endsWith(":t") ? "t" : "c";
    settings.n = { ...ch, [which]: !ch[which] };
    await saveOwnerSettings(env, settings);
    await answer(`${which === "t" ? "Telegram" : "Google Calendar"}: ${settings.n[which] ? "увімкнено" : "вимкнено"}`);
    await applyEmailReminders(env).catch(() => 0);
    return show(await remindersView(env));
  }
  if (data.startsWith("set:r:")) {
    const value = data.slice("set:r:".length);
    const marks = await reminderMarks(env);
    const m = Number(value);
    settings.r = value === "off" ? [] : marks.includes(m) ? marks.filter((x) => x !== m) : [...marks, m].sort((a, b) => b - a);
    await saveOwnerSettings(env, settings);
    await answer(settings.r.length ? `Нагадування: ${marksText(settings.r)}` : "Нагадування вимкнено");
    // The meetings of the coming week get the new reminders.
    await applyEmailReminders(env).catch(() => 0);
    return show(await remindersView(env));
  }
  await answer();
}
