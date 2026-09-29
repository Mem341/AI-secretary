/**
 * Finding a colleague by what the owner typed: «Іван Петренко», «Івану Петренку» (a Ukrainian/Russian case ending),
 * «Петренко», «Ivan Petrenko» or an email. Names are reduced to a Latin skeleton, so Cyrillic and Latin spellings
 * meet, and a word matches by its stem, so case endings do not matter.
 */

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", є: "e", ё: "e", э: "e", ж: "zh", з: "z", и: "i", і: "i",
  ї: "i", ы: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sh", ь: "", ъ: "", ю: "iu", я: "ia", "'": "", "’": "", "ʼ": "", "`": "",
};

/** The comparable form of one word: lower case, Latin, similar sounds merged. */
export function skeleton(word: string): string {
  let s = [...word.toLowerCase()].map((ch) => CYR[ch] ?? ch).join("");
  s = s
    .replace(/[^a-z]/g, "")
    .replace(/shch/g, "sh")
    .replace(/kh/g, "h")
    .replace(/h/g, "g")
    .replace(/ts|tz/g, "c")
    .replace(/[yj]/g, "i")
    .replace(/w/g, "v")
    .replace(/x/g, "ks")
    .replace(/(.)\1+/g, "$1");
  return s;
}

/** The word without a typical case ending: «петренку» → «petren», «івану» → «iva». */
function stem(word: string): string {
  if (word.length > 5) return word.slice(0, -2);
  if (word.length > 3) return word.slice(0, -1);
  return word;
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** How well one typed word fits one name word: 3 exact, 2 same stem, 1 a typo away, 0 no. */
function wordScore(typed: string, name: string): number {
  if (!typed || !name) return 0;
  if (typed === name) return 3;
  const st = stem(typed);
  if (st.length >= 3 && (name.startsWith(st) || typed.startsWith(stem(name)))) return 2;
  if (typed.length >= 5 && distance(stem(typed), stem(name)) <= 1) return 1;
  return 0;
}

export interface Person {
  id: number;
  name: string;
  lastName: string;
  secondName?: string;
  email?: string;
  position?: string;
}

export interface Match {
  person: Person;
  score: number;
  /** Every typed word matched a word of this person's name exactly or by stem. */
  full: boolean;
}

/** Best matches first. An empty list means nobody fits. */
export function matchPeople(query: string, people: Person[]): Match[] {
  const q = query.trim().toLowerCase();
  if (q.includes("@")) {
    return people.filter((p) => p.email?.toLowerCase() === q).map((person) => ({ person, score: 10, full: true }));
  }
  const typed = q.split(/[\s,.]+/).map(skeleton).filter(Boolean);
  if (!typed.length) return [];
  const out: Match[] = [];
  for (const person of people) {
    const words = [person.name, person.lastName, person.secondName ?? ""].flatMap((w) => w.split(/[\s-]+/)).map(skeleton).filter(Boolean);
    const scores = typed.map((t) => Math.max(0, ...words.map((w) => wordScore(t, w))));
    if (scores.every((s) => s === 0)) continue;
    const matched = scores.filter((s) => s > 0).length;
    out.push({ person, score: scores.reduce((a, b) => a + b, 0) + matched * 2, full: scores.every((s) => s >= 2) });
  }
  return out.sort((a, b) => Number(b.full) - Number(a.full) || b.score - a.score).slice(0, 7);
}

export const fullName = (p: Person) => [p.name, p.lastName].filter(Boolean).join(" ").trim() || p.email || `#${p.id}`;
