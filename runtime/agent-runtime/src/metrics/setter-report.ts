/**
 * The weekly setter summary as a Twenty note (tanda 24, task `setter-weekly-report`). PURE: builds
 * the title and the markdown from two weeks of metrics (src/metrics/setter.ts); no LLM, no I/O.
 *
 * «Resumen semanal del setter — semana del DD/MM 📊» (text first, emoji last: Twenty draws the icon
 * of a note with the first character of its title). Body: a short table with the change against the
 * previous week (↑ / ↓ / = and the difference), the breakdown by fair / signal, and «Para esta
 * semana» built by CODE: replies still unanswered, overdue tasks, meetings to come. Values that
 * could not be read show «n/d» and the reason goes to the footer.
 */
import { ddmm, ddmmhhmm, SETTER_COHORT_DAYS, SETTER_TIMEZONE, UNATTRIBUTED, type SetterMetrics } from './setter.js';

export const SETTER_REPORT_EMOJI = '📊';
export const SETTER_REPORT_TITLE_PREFIX = 'Resumen semanal del setter — semana del ';
/** Lines of each «Para esta semana» list. */
export const SETTER_REPORT_LIST_MAX = 8;

export function setterReportTitle(monday: string): string {
  return `${SETTER_REPORT_TITLE_PREFIX}${ddmm(monday)} ${SETTER_REPORT_EMOJI}`;
}

/** Plain text for a markdown cell or list item (no markup, no pipes, bounded). */
export function mdPlain(s: string | null | undefined, max = 120): string {
  const t = (s ?? '')
    .replace(/[`*_[\]()<>|~#\\]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

const fmtNum = (v: number, digits = 0) => v.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const ND = 'n/d';

/** «↑ +3», «↓ -2», «= 0»; «—» when either side is not available. */
export function trend(current: number | null, previous: number | null, digits = 0, unit = ''): string {
  if (current === null || previous === null) return '—';
  const d = Number((current - previous).toFixed(digits));
  if (d === 0) return '= 0';
  return `${d > 0 ? '↑ +' : '↓ '}${fmtNum(d, digits)}${unit}`;
}

export interface UpcomingMeeting {
  startsAt: string;
  company: string | null;
}

export interface SetterReportInput {
  /** Monday (local day) of the reported week. */
  monday: string;
  current: SetterMetrics;
  previous: SetterMetrics;
  /** «Para esta semana» is about NOW (the run), not about the reported week. */
  now: Date;
  /** Unanswered replies and overdue tasks as of now (the current week's metrics hold them). */
  upcoming: UpcomingMeeting[];
  timezone?: string;
}

export function renderSetterReport(i: SetterReportInput): { title: string; markdown: string } {
  const tz = i.timezone ?? SETTER_TIMEZONE;
  const c = i.current;
  const p = i.previous;
  const pct = (m: SetterMetrics) => (m.tasa_respuesta.valor === null ? null : Number((m.tasa_respuesta.valor * 100).toFixed(1)));
  const vel = (m: SetterMetrics) => m.velocidad_respuesta_comercial?.mediana_horas_laborables ?? null;
  const cell = (v: number | null, digits = 0, unit = '') => (v === null ? ND : `${fmtNum(v, digits)}${unit}`);
  const rows: Array<[string, number | null, number | null, number, string]> = [
    ['Primeros contactos', c.primeros_contactos.total, p.primeros_contactos.total, 0, ''],
    ['Seguimientos enviados', c.seguimientos_enviados, p.seguimientos_enviados, 0, ''],
    ['Respuestas humanas', c.respuestas.humanas, p.respuestas.humanas, 0, ''],
    ['Interesados', c.interesados, p.interesados, 0, ''],
    ['Tasa de respuesta (cohorte)', pct(c), pct(p), 1, ' %'],
    ['Reuniones detectadas', c.reuniones_detectadas, p.reuniones_detectadas, 0, ''],
    ['Tu respuesta: mediana (h laborables)', vel(c), vel(p), 1, ' h'],
    ['Coste LLM', c.coste_llm_eur, p.coste_llm_eur, 2, ' €'],
  ];
  const out: string[] = [];
  out.push(`**Semana del ${ddmm(c.periodo.from)} al ${ddmm(addDaysLocal(c.periodo.to, -1))}** comparada con la anterior (${ddmm(p.periodo.from)}–${ddmm(addDaysLocal(p.periodo.to, -1))}).`);
  out.push('');
  out.push('| Métrica | Esta semana | Semana anterior | Cambio |');
  out.push('| --- | --- | --- | --- |');
  for (const [label, cur, prev, digits, unit] of rows) out.push(`| ${label} | ${cell(cur, digits, unit)} | ${cell(prev, digits, unit)} | ${trend(cur, prev, digits, unit)} |`);
  out.push('');
  const opp = c.oportunidades_abiertas;
  out.push(
    opp
      ? `**Oportunidades abiertas hoy:** ${opp.total}${Object.keys(opp.por_etapa).length ? ` (${Object.entries(opp.por_etapa).map(([s, n]) => `${mdPlain(s, 40)} ${n}`).join(', ')})` : ''}.`
      : `**Oportunidades abiertas hoy:** ${ND}.`,
  );
  out.push(`**Respuestas de la semana:** ${c.respuestas.humanas} humanas (interesado ${c.respuestas.por_clase.INTERESADO}, pregunta ${c.respuestas.por_clase.PREGUNTA}, no interesado ${c.respuestas.por_clase.NO_INTERESADO}, baja ${c.respuestas.por_clase.BAJA}); rebotes ${c.respuestas.por_clase.REBOTE}; automáticas ${c.respuestas.aparte.AUTO_REPLY}; otras ${c.respuestas.aparte.OTRO}.`);
  out.push('');

  out.push('### Por feria o señal de origen');
  out.push('');
  if (!c.por_origen) out.push(`${ND}: ${mdPlain(c.no_disponible.por_origen, 200)}.`);
  else if (c.por_origen.length === 0) out.push('Sin primeros contactos ni reuniones esta semana.');
  else {
    out.push('| Origen | Contactos | Respuestas | Interesados | Reuniones |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const r of c.por_origen) out.push(`| ${r.origen === UNATTRIBUTED ? 'Sin atribuir' : mdPlain(r.origen, 80)} | ${r.primeros_contactos} | ${r.respuestas_humanas} | ${r.interesados} | ${r.reuniones} |`);
  }
  out.push('');

  out.push('### Para esta semana');
  out.push('');
  const v = c.velocidad_respuesta_comercial;
  if (!v) out.push(`- **Respuestas sin contestar:** ${ND} (${mdPlain(c.no_disponible.velocidad_respuesta_comercial, 200)}).`);
  else if (v.sin_contestar.length === 0) out.push('- **Respuestas sin contestar:** ninguna con más de un día laborable de espera.');
  else {
    out.push(`- **Respuestas sin contestar (más de un día laborable):** ${v.sin_contestar.length}. Contéstalas tú desde tu bandeja:`);
    for (const r of [...v.sin_contestar].sort((a, b) => b.workingHoursWaiting - a.workingHoursWaiting).slice(0, SETTER_REPORT_LIST_MAX))
      out.push(`  - ${mdPlain(r.from, 120)} (${r.class === 'INTERESADO' ? 'interesado' : 'pregunta'}), recibida el ${ddmmhhmm(r.receivedAt, tz)}: ${fmtNum(r.workingHoursWaiting, 1)} h laborables esperando.`);
    if (v.sin_contestar.length > SETTER_REPORT_LIST_MAX) out.push(`  - … y ${v.sin_contestar.length - SETTER_REPORT_LIST_MAX} más.`);
  }
  const t = c.tareas_vencidas;
  if (!t) out.push(`- **Tareas vencidas:** ${ND} (${mdPlain(c.no_disponible.tareas_vencidas, 200)}).`);
  else if (t.total === 0) out.push('- **Tareas vencidas:** ninguna.');
  else {
    out.push(`- **Tareas vencidas:** ${t.total}.`);
    for (const task of t.tareas.slice(0, SETTER_REPORT_LIST_MAX)) out.push(`  - ${mdPlain(task.title, 150)} (vencía el ${ddmmhhmm(task.dueAt, tz)}).`);
    if (t.total > SETTER_REPORT_LIST_MAX) out.push(`  - … y ${t.total - SETTER_REPORT_LIST_MAX} más.`);
  }
  if (i.upcoming.length === 0) out.push('- **Reuniones próximas (7 días):** ninguna detectada en tu calendario.');
  else {
    out.push(`- **Reuniones próximas (7 días):** ${i.upcoming.length}.`);
    for (const m of i.upcoming.slice(0, SETTER_REPORT_LIST_MAX)) out.push(`  - ${ddmmhhmm(m.startsAt, tz)}: ${mdPlain(m.company, 120) || 'empresa sin nombre'}.`);
  }
  out.push('');

  out.push('---');
  out.push('');
  out.push(`_Tasa de respuesta por cohorte: de los primeros contactos de la semana, cuántos tienen una respuesta humana en los ${SETTER_COHORT_DAYS} días siguientes. ${c.tasa_respuesta.cohorte_cerrada ? 'Cohorte cerrada.' : 'La cohorte de esta semana sigue abierta: el valor puede subir.'} Horas laborables: L-V 9:00-18:00, sin festivos._`);
  const missing = [...new Set([...Object.entries(c.no_disponible), ...Object.entries(p.no_disponible)].map(([k, r]) => `${k}: ${mdPlain(r, 160)}`))];
  if (missing.length > 0) out.push('', `_No disponible (n/d): ${missing.join('; ')}._`);
  if (c.truncado.length > 0) out.push('', `_Lectura parcial (mínimos): ${c.truncado.join(', ')}._`);
  out.push('', '_Generado por el Commercial OS con código, sin LLM. No envía nada: las respuestas son tuyas._');
  return { title: setterReportTitle(i.monday), markdown: out.join('\n') };
}

function addDaysLocal(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}
