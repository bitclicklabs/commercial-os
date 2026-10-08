/**
 * Vocabulary of the synthetic generator: invented roots, invented places, sectors and phrase
 * variants. Names are built from invented syllables and invented places, so they do not name
 * real companies; every web domain and URL is under `.invalid` (RFC 6761: guaranteed never to
 * resolve), so a synthetic exhibitor can never be fetched, and the Twenty client refuses to
 * write a `.invalid` domain to a real CRM (src/integrations/twenty/client.ts).
 */
import type { Rng } from './prng.js';

/** The only TLD the generator uses (RFC 6761 reserved, never resolves). */
export const SYNTHETIC_TLD = 'invalid';

const ROOT_A = ['Zor', 'Vel', 'Quen', 'Ostr', 'Brix', 'Talv', 'Nym', 'Karv', 'Lux', 'Ferv', 'Drov', 'Yal', 'Grenz', 'Prax', 'Sulv', 'Wend'];
const ROOT_B = ['andra', 'oria', 'exa', 'ilo', 'enza', 'arix', 'itra', 'umbe', 'olva', 'aqui', 'ezna', 'ovix'];

/** Invented places (no real municipality uses these names). */
export const PLACES = ['Brumaval', 'Quintaluz', 'Ostravela', 'Zarcobre', 'Velandria', 'Nublacastro', 'Lirivalle', 'Cenizaroca', 'Torrebruma', 'Valdecristal'];

export function root(rng: Rng): string {
  return `${rng.pick(ROOT_A)}${rng.pick(ROOT_B)}`;
}

/** lower-case a-z0-9 with hyphens, no diacritics (domain labels, entity keys). */
export function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

export function syntheticDomain(label: string): string {
  return `${slug(label)}.${SYNTHETIC_TLD}`;
}

export const LEGAL = ['S.L.', 'S.A.', 'S.L.U.'];

export interface Sector {
  /** Activity word in the company name ("Conservas", "Cafés"...). */
  activity: string;
  /** `sector` field as an exhibitor catalog would show it. */
  sector: string;
  /** What the company makes or sells (description). */
  product: string;
  /** A launch the company presents at the fair. */
  launch: string;
}

export const SECTORS: readonly Sector[] = [
  { activity: 'Conservas', sector: 'Alimentación gourmet', product: 'conservas de pescado y marisco', launch: 'su nueva línea de ventresca en aceite de oliva' },
  { activity: 'Cafés', sector: 'Café y bebidas calientes', product: 'café tostado para hostelería', launch: 'una gama de cápsulas compostables' },
  { activity: 'Quesos', sector: 'Lácteos y quesos', product: 'quesos curados de oveja', launch: 'un queso madurado en bodega' },
  { activity: 'Panificadora', sector: 'Panadería y bollería', product: 'pan precocido y bollería congelada', launch: 'una masa madre de larga fermentación' },
  { activity: 'Bodegas', sector: 'Vinos y espirituosos', product: 'vinos tintos y rosados de crianza', launch: 'un espumoso de edición limitada' },
  { activity: 'Cosmética', sector: 'Cosmética natural', product: 'cosmética natural certificada', launch: 'una línea solar sin perfume' },
  { activity: 'Maquinaria', sector: 'Equipamiento para hostelería', product: 'hornos y cámaras de frío para hostelería', launch: 'un horno mixto de bajo consumo' },
  { activity: 'Envases', sector: 'Packaging alimentario', product: 'envases reciclables para alimentación', launch: 'una bandeja compostable' },
];

export const FAIR_KINDS = [
  { name: 'Feria de Alimentación', sector: 'alimentación' },
  { name: 'Salón de Hostelería', sector: 'hostelería' },
  { name: 'Expo Gastronómica', sector: 'gastronomía' },
] as const;

export const MERCH_ITEMS = ['bolsas tote de algodón', 'lanyards', 'botellas reutilizables', 'libretas', 'bolígrafos', 'tazas'];

/** Phrase variants (seeded choice), so cases of one template do not read identically. */
export const PHRASES = {
  need: [
    'Busca proveedor de regalo promocional para los visitantes del stand.',
    'Quiere repartir obsequios personalizados con su marca durante la feria.',
    'Su equipo de marketing está pidiendo presupuestos de merchandising para la feria.',
  ],
  presence: ['ocupa un stand de {m2} m² con {k} comerciales', 'expone en un stand de {m2} m² y acude con {k} comerciales', 'dispone de un stand de {m2} m² atendido por {k} personas de su equipo comercial'],
  company: ['Fabricante de {product} con {emp} empleados', 'Empresa familiar de {product} con {emp} trabajadores', 'Productor de {product} con una plantilla de {emp} personas'],
  exports: ['y exportación a {n} países', 'que vende en {n} países', 'y presencia comercial en {n} países'],
  unknownSize: [
    'No ha comunicado el tamaño de su stand ni cuántas personas acudirán.',
    'La organización no ha publicado todavía el tamaño de su stand ni el número de comerciales.',
    'Se desconoce cuántos metros ocupa su stand y cuántos comerciales enviará.',
  ],
} as const;

/** Fills `{key}` placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => String(values[k] ?? `{${k}}`));
}

/** Spanish thousands separator from 10.000 up (RAE), without ICU so the output never depends on the Node build. */
export function es(n: number): string {
  const s = String(Math.trunc(n));
  return s.length <= 4 ? s : s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
