import type { Env } from "../env";
import { chatText } from "../llm/openrouter";

const INSTRUCTION =
  "Транскрибуй це голосове повідомлення дослівно, мовою оригіналу (зазвичай українська або російська). " +
  "Поверни лише текст без коментарів, лапок і позначок часу. Якщо мовлення немає — поверни порожній рядок.";

/**
 * Speech-to-text through OpenRouter (audio input to a multimodal model, STT_MODEL), so voice needs no extra key.
 * Telegram voice notes are OGG/Opus.
 */
export async function transcribe(env: Env, audio: Uint8Array, format = "ogg"): Promise<string> {
  const text = await chatText(env, env.STT_MODEL, [
    {
      role: "user",
      content: [
        { type: "text", text: INSTRUCTION },
        { type: "input_audio", input_audio: { data: Buffer.from(audio).toString("base64"), format } },
      ],
    },
  ]);
  return text.trim();
}
