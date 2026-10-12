/**
 * Deterministic extraction of email addresses from a company's own web pages (pure, unit
 * tested). No LLM: `mailto:` links, Cloudflare-protected addresses, JSON-LD `email`, plain
 * text and simple obfuscations ("nombre [at] dominio [punto] com", "info (arroba) x.es",
 * "ventas arroba x punto com", HTML entities). When a person name and a job title are
 * published right next to an address, they are captured too.
 *
 * Everything returned here is UNTRUSTED web data: the addresses are validated by syntax,
 * names / titles / context are plain text for the Research (escaped there) and, inside a
 * <<<DATOS_NO_CONFIABLES>>> block, for the optional LLM tie-break.
 */
import { normalizeEmail } from '../inbound/unsubscribe-classifier.js';
import { decodeEntities, htmlToText } from '../tools/web/html-text.js';
import { fold, roleKindOf } from './classify.js';

export type ExtractVia = 'mailto' | 'text' | 'obfuscated' | 'cfemail' | 'jsonld';

export interface EmailOccurrence {
  email: string;
  via: ExtractVia;
  /** Person name published next to the address, if any (untrusted). */
  name: string | null;
  /** Job title published next to the address, if any (untrusted). */
  jobTitle: string | null;
  /** The text around the address, max 300 chars (untrusted). */
  context: string | null;
}

/** "TLDs" that are really file extensions (`logo@2x.png`). */
const FILE_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'css', 'js', 'json', 'pdf', 'php', 'html', 'htm', 'xml', 'mp4', 'webm', 'woff', 'woff2', 'ttf']);

const EMAIL_IN_TEXT = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}(?![a-z0-9-])/gi;

/** Normalised address, or null for invalid ones and file names that look like addresses. */
export function cleanEmail(raw: string): string | null {
  const email = normalizeEmail(raw.trim().replace(/^mailto:/i, '').replace(/[.,;:]+$/, ''));
  if (!email) return null;
  const tld = email.slice(email.lastIndexOf('.') + 1);
  if (FILE_TLDS.has(tld)) return null;
  return email;
}

/** Every valid address in a piece of text, in order, without duplicates. */
export function emailsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL_IN_TEXT)) {
    const e = cleanEmail(m[0]);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Undoes the usual hand-made obfuscations. Conservative on purpose: a spelled-out "at"
 * only counts when a spelled-out "dot"/"punto" follows, so normal prose is not rewritten.
 */
export function deobfuscate(text: string): string {
  let t = text.replace(/＠/g, '@');
  t = t.replace(/\s*[[({<]\s*(?:at|arroba|@)\s*[\])}>]\s*/gi, '@');
  t = t.replace(/\s*[[({<]\s*(?:dot|punto|\.)\s*[\])}>]\s*/gi, '.');
  t = t.replace(
    /\b([a-z0-9][a-z0-9._%+-]*)\s+(?:at|arroba)\s+([a-z0-9-]+(?:\s+(?:dot|punto)\s+[a-z0-9-]+)+)\b/gi,
    (_m, local: string, domain: string) => `${local}@${domain.replace(/\s+(?:dot|punto)\s+/gi, '.')}`,
  );
  // "info @ empresa.es" / "info@ empresa.es": spaces around the @ only.
  t = t.replace(/\b([a-z0-9][a-z0-9._%+-]*)(?:\s+@\s*|\s*@\s+)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi, (_m, l: string, d: string) => `${l}@${d}`);
  return t;
}

/** Cloudflare "email protection": hex string, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return cleanEmail(out);
}

// ---------------------------------------------------------------------------
// Name and job title next to an address
// ---------------------------------------------------------------------------

/** Generic words that look like a capitalised name but are not one (folded). */
const NOT_NAME_WORDS = new Set([
  'departamento', 'dpto', 'area', 'contacto', 'contacta', 'contactanos', 'email', 'e-mail', 'correo', 'mail', 'telefono', 'tel', 'tlf', 'movil', 'fax', 'web',
  'director', 'directora', 'gerente', 'responsable', 'jefe', 'jefa', 'manager', 'comercial', 'marketing', 'ventas', 'compras', 'export', 'exportacion', 'sales',
  'general', 'atencion', 'cliente', 'clientes', 'oficina', 'oficinas', 'central', 'sede', 'horario', 'calle', 'avenida', 'avda', 'plaza', 'poligono', 'carretera',
  'informacion', 'info', 'aviso', 'legal', 'politica', 'privacidad', 'cookies', 'empresa', 'equipo', 'nosotros', 'quienes', 'somos', 'inicio', 'home', 'blog',
  'tienda', 'productos', 'servicios', 'espana', 'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'escribenos', 'llamanos', 'siguenos', 'nuestro', 'nuestra',
  'el', 'la', 'los', 'las', 'de', 'del', 'y', 'para', 'con', 'por', 'en', 'a', 's.l', 's.a', 'sl', 'sa', 'slu', 'ceo', 'cfo', 'coo', 'key', 'account', 'trade',
  'ctra', 'pol', 'apdo', 'apartado', 'urb', 'urbanizacion', 'parcela', 'nave', 'local',
  'administracion', 'administrador', 'administradora', 'presidente', 'presidenta', 'fundador', 'fundadora', 'socio', 'socia', 'grupo', 'lunes', 'martes',
]);

const NAME_RE = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñü]{1,20}(?:\s+(?:de\s+(?:la\s+|los\s+)?|del\s+|y\s+)?[A-ZÁÉÍÓÚÑ][a-záéíóúñü]{1,20}){1,3})\b/g;

/** Words that make a line read as a job title even when no relevant kind matches. */
const JOB_WORDS = /\b(director|directora|gerente|responsable|jefe|jefa|manager|head of|coordinador|coordinadora|tecnic[oa]|administrativ[oa]|ceo|cfo|coo|cmo|fundador|fundadora|founder|propietari[oa]|president[ea]?|consejer[oa]|delegad[oa]|comercial|ejecutiv[oa]|key account|buyer|compras|ventas|marketing|export)\b/;

/** First plausible person name in `text` (2-4 capitalised words, none of them a generic word), or null. */
export function findPersonName(text: string, exclude: readonly string[] = []): string | null {
  const banned = new Set([...NOT_NAME_WORDS, ...exclude.flatMap((e) => fold(e).split(/[\s.,]+/)).filter((w) => w.length > 2)]);
  for (const m of text.matchAll(NAME_RE)) {
    const words = m[1]!.split(/\s+/).filter((w) => !/^(de|del|la|los|y)$/i.test(w));
    if (words.length < 2) continue;
    if (words.some((w) => banned.has(fold(w)))) continue;
    return m[1]!.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** The job title in a line: the line minus addresses, name and labels, if it reads as a title. */
function titleIn(line: string, name: string | null): string | null {
  let t = line.replace(EMAIL_IN_TEXT, ' ');
  if (name) t = t.replace(name, ' ');
  t = t
    .replace(/\b(e-?mail|correo( electr[oó]nico)?|tel[eé]fono|tel|tlf|m[oó]vil|fax)\s*[:.]?/gi, ' ')
    .replace(/[|•·–—:;,()[\]]+/g, ' ')
    .replace(/\+?\d[\d\s]{6,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—\s]+|[-–—\s]+$/g, '');
  // A job title is short: a sentence of the legal notice that mentions "responsable" is not one.
  if (t.length < 3 || t.length > 80 || t.split(' ').length > 8 || /[.!?]\s/.test(t)) return null;
  const f = fold(t);
  return JOB_WORDS.test(f) || roleKindOf(t) ? t : null;
}

/**
 * Name and title around line `i`: the same line first, then up to two lines above, stopping
 * at a line with another address (it belongs to someone else).
 */
function personAround(lines: string[], i: number, exclude: readonly string[]): { name: string | null; jobTitle: string | null; context: string } {
  const window: string[] = [deobfuscate(lines[i]!)];
  for (let k = i - 1; k >= Math.max(0, i - 6) && window.length < 3; k--) {
    const l = lines[k]!;
    if (l.trim().length === 0) continue;
    if (EMAIL_IN_TEXT.test(deobfuscate(l))) {
      EMAIL_IN_TEXT.lastIndex = 0;
      break;
    }
    EMAIL_IN_TEXT.lastIndex = 0;
    window.push(deobfuscate(l));
  }
  let name: string | null = null;
  let jobTitle: string | null = null;
  for (const l of window) {
    name ??= findPersonName(l, exclude);
  }
  for (const l of window) {
    jobTitle ??= titleIn(l, name);
  }
  const context = [...window].reverse().join(' · ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { name, jobTitle, context };
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface PageContent {
  /** Final URL of the page (after redirects). */
  url: string;
  /** Decoded HTML, when the page was fetched (not when it was rendered). */
  html: string | null;
  /** Visible text (htmlToText of the HTML, or the renderer's text). */
  text: string;
}

/** Strips tags from an HTML fragment (for the context of a mailto link). */
function fragmentText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/?(?:br|p|div|li|tr|h[1-6]|section|article|header|footer|dt|dd|td|th)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Every address published on one page, with how it was found and the person next to it.
 * `exclude`: words that are never a person name here (the company name).
 */
export function extractFromPage(page: PageContent, opts: { exclude?: readonly string[] } = {}): EmailOccurrence[] {
  const exclude = opts.exclude ?? [];
  const found = new Map<string, EmailOccurrence>();
  const add = (o: EmailOccurrence) => {
    const prev = found.get(o.email);
    if (!prev) {
      found.set(o.email, o);
      return;
    }
    prev.name ??= o.name;
    prev.jobTitle ??= o.jobTitle;
    prev.context ??= o.context;
  };

  const text = page.html !== null ? htmlToText(page.html, page.url).text : page.text;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const plain = emailsInText(line);
    const decoded = deobfuscate(line);
    const all = emailsInText(decoded);
    if (all.length === 0) return;
    const around = personAround(lines, i, exclude);
    // Several addresses on one line: the person data is only reliable when there is one.
    const single = all.length === 1;
    for (const email of all) {
      add({
        email,
        via: plain.includes(email) ? 'text' : 'obfuscated',
        name: single ? around.name : null,
        jobTitle: single ? around.jobTitle : null,
        context: around.context,
      });
    }
  });

  if (page.html !== null) {
    const html = page.html.replace(/<!--[\s\S]*?-->/g, ' ');
    // mailto: links (href may be entity- or percent-encoded, may carry ?subject=...).
    const anchor = /<a\b([^>]*?)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    for (const m of html.matchAll(anchor)) {
      const href = decodeEntities((m[2] ?? m[3] ?? m[4] ?? '').trim());
      const cf = /\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i.exec(href);
      let emails: string[] = [];
      let via: ExtractVia = 'mailto';
      if (/^mailto:/i.test(href)) {
        const target = safeDecodeUri(href.slice(7).split('?')[0]!);
        emails = target.split(/[,;]/).map(cleanEmail).filter((e): e is string => e !== null);
      } else if (cf) {
        const e = decodeCfEmail(cf[1]!);
        if (e) emails = [e];
        via = 'cfemail';
      }
      if (emails.length === 0) continue;
      const before = fragmentText(html.slice(Math.max(0, m.index - 600), m.index)).split('\n').slice(-2);
      const anchorText = fragmentText(m[6] ?? '').replace(/\n/g, ' ');
      const ctxLines = [...before, anchorText].filter((l) => l.length > 0);
      const around = ctxLines.length > 0 ? personAround(ctxLines, ctxLines.length - 1, exclude) : { name: null, jobTitle: null, context: '' };
      for (const email of emails) {
        add({ email, via, name: emails.length === 1 ? around.name : null, jobTitle: emails.length === 1 ? around.jobTitle : null, context: around.context || null });
      }
    }
    for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) {
      const e = decodeCfEmail(m[1]!);
      if (e) add({ email: e, via: 'cfemail', name: null, jobTitle: null, context: null });
    }
    // schema.org JSON-LD: "email": "info@x.es" (the scripts are dropped from the text).
    for (const m of html.matchAll(/"email"\s*:\s*"(?:mailto:)?([^"\s]{3,254})"/gi)) {
      const e = cleanEmail(safeDecodeUri(m[1]!));
      if (e) add({ email: e, via: 'jsonld', name: null, jobTitle: null, context: null });
    }
  }
  return [...found.values()];
}
