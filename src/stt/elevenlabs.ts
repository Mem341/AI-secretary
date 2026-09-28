import type { Env } from "../env";
import { expectOk, fetchWithRetry } from "../lib/http";

export interface Transcript {
  text: string;
  words?: { text: string; start: number; end: number; speaker_id?: string; type?: string }[];
}

/** ElevenLabs Scribe speech-to-text, Ukrainian (spec section 3). */
export async function transcribe(
  env: Env,
  audio: Uint8Array<ArrayBuffer>,
  filename: string,
  { diarize = false }: { diarize?: boolean } = {},
): Promise<Transcript> {
  const form = new FormData();
  form.append("model_id", env.STT_MODEL);
  form.append("language_code", "uk");
  form.append("diarize", String(diarize));
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([audio]), filename);
  const res = await fetchWithRetry("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    body: form,
  });
  await expectOk("elevenlabs", res);
  return (await res.json()) as Transcript;
}
