const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  trade: "™",
  copy: "©",
  reg: "®",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * HTML (possibly entity-escaped, as Greenhouse sends it) to readable plain text,
 * keeping paragraph and list breaks.
 */
export function htmlToText(input: string): string {
  let html = input;
  // Greenhouse escapes the markup itself ("&lt;p&gt;"); unescape until real tags appear.
  for (let i = 0; i < 2 && /&lt;\/?[a-z]/i.test(html); i += 1) html = decodeEntities(html);
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first one or two sentences of a description, for the feed card. */
export function summarize(description: string | null, maxLength = 220): string {
  if (!description) return "";
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > maxLength) break;
    out += s;
  }
  if (out.trim().length >= 40) return out.trim();
  return `${flat.slice(0, maxLength - 1).replace(/\s+\S*$/, "")}…`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Builds a case-insensitive matcher for whole words or phrases.
 *
 * The Python pipeline used plain substrings, so "sr" excluded every "SRE" role
 * and "lead" excluded "Leading". Phrases now match only at word edges.
 */
export function phraseMatcher(phrases: readonly string[]): (text: string) => string | null {
  const cleaned = phrases.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return () => null;
  const re = new RegExp(`(?<![a-z0-9])(${cleaned.map(escapeRe).join("|")})(?![a-z0-9])`, "i");
  return (text: string) => re.exec(text)?.[1]?.toLowerCase() ?? null;
}
