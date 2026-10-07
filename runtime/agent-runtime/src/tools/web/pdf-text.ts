/**
 * PDF -> plain text for `fetch_url` (catálogos y listados de expositores en PDF).
 *
 * Usa `unpdf` (build "serverless" de PDF.js, JavaScript puro, sin binarios nativos).
 * El PDF es contenido NO CONFIABLE:
 * - el build de PDF.js de unpdf 1.8 no contiene `eval` ni `new Function` (la vía de
 *   CVE-2024-4367 ya no existe); además sin fuentes del sistema ni `FontFace`, sin XFA
 *   y sin peticiones externas (no hay `url`, solo `data` en memoria);
 * - límite de páginas, de caracteres y de tiempo (la señal de abort del fetch);
 * - solo devuelve texto, título y enlaces http(s) de las anotaciones de tipo Link.
 */
import type { PageLink } from './html-text.js';

export const PDF_MAX_PAGES = 300;

export interface PdfText {
  title: string | null;
  text: string;
  links: PageLink[];
  pages: number;
  pagesRead: number;
  /** Text cut at `maxChars` (or at the page limit). */
  truncated: boolean;
}

/** True if the body starts with the PDF signature `%PDF-` (leading whitespace / BOM allowed, within 1 KB). */
export function looksLikePdf(contentType: string | null, body: Buffer): boolean {
  if (contentType && /^application\/(?:x-)?pdf$/i.test(contentType)) return true;
  const head = body.subarray(0, 1024).toString('latin1');
  return /^[\s﻿ï»¿]*%PDF-/.test(head);
}

export class PdfError extends Error {
  constructor(
    readonly code: 'PDF_UNREADABLE' | 'PDF_ENCRYPTED' | 'PDF_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  /** [a, b, c, d, e, f]: e/f = x/y of the run origin. */
  transform?: number[];
  width?: number;
}

/**
 * Joins PDF.js text runs into lines: a newline at `hasEOL` or when the baseline
 * changes, a space when there is a horizontal gap between two runs of the same line
 * (table cells, kerning-split words stay together).
 */
export function joinTextItems(items: TextItemLike[]): string {
  let out = '';
  let prev: TextItemLike | null = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const t = item.transform;
    const p = prev?.transform;
    if (prev && !prev.hasEOL && t && p && t.length >= 6 && p.length >= 6) {
      const size = Math.max(1, Math.abs(t[3]!) || Math.hypot(t[2]!, t[3]!));
      const sameLine = Math.abs(t[5]! - p[5]!) < size * 0.5;
      if (!sameLine) out += '\n';
      else if (t[4]! - (p[4]! + (prev.width ?? 0)) > size * 0.15 && !/\s$/.test(out) && !/^\s/.test(item.str)) out += ' ';
    }
    out += item.str;
    if (item.hasEOL) out += '\n';
    prev = item;
  }
  return out;
}

function collapsePdf(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v  -​  　]+/g, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts the text of a PDF held in memory. Throws `PdfError` when the document cannot
 * be parsed (corrupt, encrypted, cut by the download cap).
 */
export async function pdfToText(body: Buffer, opts: { maxChars: number; signal?: AbortSignal; maxPages?: number; bytesTruncated?: boolean }): Promise<PdfText> {
  const { getDocumentProxy } = await import('unpdf');
  // PDF.js transfers/detaches the buffer it gets: hand it a copy.
  const data = new Uint8Array(body.byteLength);
  data.set(body);
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(data, {
      useSystemFonts: false,
      enableXfa: false,
      disableFontFace: true,
      stopAtErrors: false,
      verbosity: 0,
    });
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    const msg = err instanceof Error ? err.message : String(err);
    if (name === 'PasswordException') throw new PdfError('PDF_ENCRYPTED', 'the PDF is password protected');
    if (opts.bytesTruncated) throw new PdfError('PDF_TOO_LARGE', `the PDF exceeds the download cap and could not be parsed (${msg})`);
    throw new PdfError('PDF_UNREADABLE', `the PDF could not be parsed (${msg})`);
  }
  try {
    const pages = doc.numPages;
    const maxPages = Math.min(pages, opts.maxPages ?? PDF_MAX_PAGES);
    let title: string | null = null;
    try {
      const meta = await doc.getMetadata();
      const t = (meta.info as { Title?: unknown } | undefined)?.Title;
      if (typeof t === 'string' && t.trim()) title = collapsePdf(t).replace(/\n+/g, ' ').slice(0, 300);
    } catch {
      // Metadata is optional.
    }
    const parts: string[] = [];
    const links: PageLink[] = [];
    const seen = new Set<string>();
    let chars = 0;
    let pagesRead = 0;
    for (let n = 1; n <= maxPages; n++) {
      opts.signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const pageText = joinTextItems(content.items as TextItemLike[]);
      try {
        for (const a of (await page.getAnnotations()) as Array<{ subtype?: string; url?: unknown }>) {
          if (a.subtype !== 'Link' || typeof a.url !== 'string' || links.length >= 200) continue;
          let u: URL;
          try {
            u = new URL(a.url);
          } catch {
            continue;
          }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
          u.hash = '';
          const key = u.toString();
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ url: key, text: '' });
        }
      } catch {
        // Annotations are optional.
      }
      page.cleanup();
      pagesRead = n;
      parts.push(pageText);
      chars += pageText.length;
      // A little over the cap: the caller cuts exactly and reports `truncated`.
      if (chars > opts.maxChars * 1.2 + 1_000) break;
    }
    const text = collapsePdf(parts.join('\n\n'));
    return { title, text, links, pages, pagesRead, truncated: pagesRead < pages };
  } finally {
    await doc.loadingTask.destroy().catch(() => undefined);
  }
}
