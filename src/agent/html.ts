/**
 * The n8n "Parse Agent Output" node: turns a model answer into safe Telegram HTML — code fences out, a JSON
 * {"response": …} unwrapped, only Telegram's tags kept, unclosed tags closed, stray "&" escaped, 4000 chars max.
 */
const ALLOWED = ["b", "i", "u", "s", "a", "code", "pre", "tg-spoiler"];

export function toTelegramHtml(output: string): string {
  let response = output.replace(/```html\n?/g, "").replace(/```\n?/g, "");
  try {
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { response?: unknown };
      if (typeof parsed.response === "string") response = parsed.response;
    }
  } catch {
    /* not JSON */
  }

  // Markdown leftovers → HTML (the supervisor prompt asks for HTML, models sometimes forget).
  response = response
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

  // 1. Only Telegram's tags survive.
  response = response.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (m, tag: string) => (ALLOWED.includes(tag.toLowerCase()) ? m : ""));

  // Telegram's limit, cut before balancing so the cut never leaves a tag open.
  if (response.length > 4000) response = `${response.substring(0, 4000).replace(/<[^>]*$/, "")}\n\n...✂️`;

  // 2. Balance open/close tags.
  for (const tag of ALLOWED) {
    const opens = (response.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "gi")) ?? []).length;
    const closes = (response.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
    if (opens > closes) response += `</${tag}>`.repeat(opens - closes);
    if (closes > opens) {
      let excess = closes - opens;
      response = response.replace(new RegExp(`</${tag}>`, "gi"), (m) => (excess-- > 0 ? "" : m));
    }
  }

  // 3. "&" that is not an entity; "<" / ">" that are not part of a kept tag.
  response = response.replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, "&amp;");
  response = response.replace(/<(?!\/?(b|i|u|s|a|code|pre|tg-spoiler)\b)/gi, "&lt;");

  return response.trim() || "🙂";
}
