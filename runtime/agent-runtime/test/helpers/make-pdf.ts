/**
 * Builds a tiny valid PDF in memory (no dependencies): one page per entry of `pages`,
 * one text line per string (Helvetica, WinAnsiEncoding, so Spanish accents work),
 * optional URI link annotations and an /Info /Title. Used as the PDF fixture of the
 * fetch_url and scout tests.
 */
export interface MakePdfOptions {
  title?: string;
  /** Link annotations (URI actions) added to the first page. */
  links?: string[];
}

function pdfString(s: string): string {
  return `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}

export function makePdf(pages: string[][], opts: MakePdfOptions = {}): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const linkObjs = (opts.links ?? []).map((uri, i) =>
    add(`<< /Type /Annot /Subtype /Link /Rect [50 ${100 + i * 20} 300 ${115 + i * 20}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(uri)} >> >>`),
  );
  const pageIds: number[] = [];
  pages.forEach((lines, idx) => {
    const ops = ['BT', '/F1 11 Tf', '50 800 Td', ...lines.flatMap((l, i) => [...(i > 0 ? ['0 -16 Td'] : []), `${pdfString(l)} Tj`]), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    const annots = idx === 0 && linkObjs.length > 0 ? ` /Annots [${linkObjs.map((n) => `${n} 0 R`).join(' ')}]` : '';
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${annots} >>`));
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const info = opts.title ? add(`<< /Title ${pdfString(opts.title)} /Producer (pxos test) >>`) : null;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
