import { esc } from "./telegram/api";

/** One row of the setup checklist. */
export interface SetupStep {
  status: "ok" | "todo" | "optional" | "error";
  title: string;
  /** Trusted HTML (callers escape dynamic parts). */
  details?: string;
}

const ICON: Record<SetupStep["status"], string> = { ok: "✓", todo: "!", optional: "○", error: "✕" };

/** Self-contained setup page for whoever deployed this copy: what works and what is left to do. */
export function renderSetupPage(steps: SetupStep[], footer = ""): Response {
  const done = steps.filter((s) => s.status === "ok").length;
  const required = steps.filter((s) => s.status !== "optional").length;
  const ready = steps.every((s) => s.status === "ok" || s.status === "optional");
  const rows = steps
    .map(
      (s) => `<li class="step ${s.status}"><span class="icon" aria-hidden="true">${ICON[s.status]}</span>
<div><h2>${s.title}</h2>${s.details ? `<div class="details">${s.details}</div>` : ""}</div></li>`,
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI-secretary · налаштування</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#5d6675;--line:#e3e6eb;--ok:#1a7f4b;--todo:#b25e09;--err:#c0262d;--opt:#7a8290;--code:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e8eaee;--muted:#9aa3b2;--line:#262b35;--ok:#4cc38a;--todo:#f0a14a;--err:#f06b70;--opt:#7d8594;--code:#222733}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:44rem;margin:0 auto;padding:40px 16px 64px}
header h1{font-size:1.6rem;margin:0 0 4px}header p{margin:0;color:var(--muted)}
.badge{display:inline-block;margin-top:14px;padding:4px 12px;border-radius:999px;font-size:.9rem;font-weight:600;background:var(--card);border:1px solid var(--line)}
.badge.ready{color:var(--ok);border-color:var(--ok)}
ol{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:12px}
.step{display:flex;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.icon{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:700;color:#fff}
.ok .icon{background:var(--ok)}.todo .icon{background:var(--todo)}.error .icon{background:var(--err)}.optional .icon{background:var(--opt)}
h2{font-size:1.02rem;margin:2px 0 0}.details{color:var(--muted);margin-top:6px;font-size:.95rem}
.details ol{list-style:decimal;display:block;margin:6px 0 0;padding-left:1.2rem}.details li{margin:3px 0}
code{background:var(--code);padding:2px 6px;border-radius:6px;font-size:.88em;word-break:break-all}
a{color:inherit}.button{display:inline-block;margin-top:8px;padding:8px 14px;border-radius:10px;background:var(--text);color:var(--bg);text-decoration:none;font-weight:600}
footer{margin-top:28px;color:var(--muted);font-size:.9rem}
</style></head>
<body><main>
<header><h1>🗓 AI-secretary</h1><p>Особистий Telegram-секретар. Ця сторінка показує, що вже налаштовано у вашому розгортанні.</p>
<span class="badge${ready ? " ready" : ""}">${ready ? "Готово до роботи" : `Готово ${done} з ${required}`}</span></header>
<ol>${rows}</ol>
<footer>${footer}Сторінку можна оновлювати скільки завгодно — вона нічого не ламає.</footer>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function code(text: string): string {
  return `<code>${esc(text)}</code>`;
}
