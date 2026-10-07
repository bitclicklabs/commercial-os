/**
 * Dependency-free HTML -> plain text for `fetch_url`. Not a full HTML parser: it
 * drops non-content elements (script, style, svg, templates...), turns block
 * elements into line breaks, strips the remaining tags and decodes entities.
 * Good enough to feed an LLM extraction step; the output is untrusted data.
 */

export interface PageLink {
  url: string;
  text: string;
}

export interface ExtractedPage {
  title: string | null;
  text: string;
  links: PageLink[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', euro: '€', deg: '°', ordm: 'º', ordf: 'ª', iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ccedil: 'ç',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü', Ccedil: 'Ç',
  agrave: 'à', egrave: 'è', ograve: 'ò', Agrave: 'À', Egrave: 'È', Ograve: 'Ò', auml: 'ä', ouml: 'ö',
  times: '×', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

const DROP_ELEMENTS = ['title', 'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'canvas', 'select', 'head'];
const BLOCK_TAGS =
  'address|article|aside|blockquote|br|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|thead|tfoot|tr|ul|caption';

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v   -​  　]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** Absolute http(s) links of the page, deduplicated, fragment removed. */
function extractLinks(html: string, baseUrl: string, max: number): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    const href = attr(` ${m[1]!}`, 'href');
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href.trim()), baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = collapse(decodeEntities(m[2]!.replace(/<[^>]*>/g, ' '))).replace(/\n+/g, ' ').slice(0, 200);
    out.push({ url: key, text });
  }
  return out;
}

export interface JsAppVerdict {
  likely: boolean;
  /** `<script>` elements (inline + external). */
  scripts: number;
  /** Characters of inline script code. */
  scriptChars: number;
  textChars: number;
  /** Why it looks like a JavaScript app (empty when `likely` is false). */
  reasons: string[];
}

/** Empty mount points of the usual SPA frameworks (React, Vue, Angular, Nuxt, Quasar, Svelte...). */
const EMPTY_MOUNT = /<(div|main|section|app-root)\b[^>]*\bid\s*=\s*["']?(?:app|root|__nuxt|__next|q-app|svelte|main-app|application)["']?[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<\/\1\s*>/i;
const FRAMEWORK_MARKERS = /<app-root\b|\bng-version=|\bdata-reactroot\b|\bdata-server-rendered\b|window\.__NUXT__|__NEXT_DATA__|\bdata-v-app\b|webpackChunk|\/_next\/static\/|\/_nuxt\//i;
const NOSCRIPT_JS = /<noscript\b[^>]*>[\s\S]{0,400}?(?:javascript|enable js|habilit|activ)[\s\S]{0,200}?<\/noscript\s*>/i;

/**
 * Heuristic: does this HTML need JavaScript to show its content? (little visible text,
 * a lot of script, an empty SPA mount point or a "enable JavaScript" notice). Used by
 * the scout to decide when to call `render_url`. `text` is the output of `htmlToText`.
 */
export function detectJsApp(html: string, text: string): JsAppVerdict {
  let scripts = 0;
  let scriptChars = 0;
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    scripts += 1;
    scriptChars += m[1]!.trim().length;
  }
  const textChars = text.replace(/\s+/g, ' ').trim().length;
  const reasons: string[] = [];
  if (scripts > 0 && textChars < 400) reasons.push('casi sin texto visible');
  if (scripts > 0 && textChars < 3_000 && scriptChars > textChars * 4) reasons.push('mucho más script que texto');
  if (EMPTY_MOUNT.test(html) && textChars < 3_000) reasons.push('punto de montaje de SPA vacío');
  if (NOSCRIPT_JS.test(html) && textChars < 3_000) reasons.push('aviso <noscript> de JavaScript');
  if (FRAMEWORK_MARKERS.test(html) && textChars < 1_500) reasons.push('marcadores de framework JS con poco texto');
  return { likely: reasons.length > 0, scripts, scriptChars, textChars, reasons };
}

export function htmlToText(html: string, baseUrl: string, opts: { maxLinks?: number } = {}): ExtractedPage {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch ? collapse(decodeEntities(titleMatch[1]!.replace(/<[^>]*>/g, ''))).replace(/\n+/g, ' ').slice(0, 300) || null : null;

  let body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  const links = extractLinks(body, baseUrl, opts.maxLinks ?? 200);
  for (const tag of DROP_ELEMENTS) {
    body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  // Elements explicitly hidden from people are a classic prompt-injection carrier.
  body = body.replace(/<([a-z][a-z0-9]*)\b[^>]*\s(?:hidden(?=[\s>=/])|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*display\s*:\s*none)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  body = body
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' | ')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = attr(tag, 'alt');
      return alt ? ` ${alt} ` : ' ';
    })
    .replace(/<[^>]*>/g, ' ');
  return { title, text: collapse(decodeEntities(body)), links };
}
