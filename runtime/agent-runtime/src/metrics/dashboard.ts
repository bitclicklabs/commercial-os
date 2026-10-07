/**
 * Mini dashboard (LLD v0.1 section 17.2), served by GET /dashboard. Self-contained: inline
 * HTML, CSS and vanilla JS, no frameworks or CDNs. Every fetch uses a RELATIVE path
 * (`metrics/...`, `task-runs/...`), so the page works behind any host/port. The tenant is
 * taken from `?tenant=` and sent as `x-tenant-id`; without it the runtime default applies.
 * All DB text is inserted with textContent (never innerHTML).
 * ARCHIVED agents (test agents) are hidden from the agent table and the latest runs; open
 * the page with `?include_archived=true` to see them. The summary cards count every run.
 * The "Email" block (email-ops) reads `email` of /metrics/summary: sends from Twenty today,
 * this week and in total, the warm-up target of the day (amber when exceeded) and the
 * informative IONOS hourly limit.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent OS · Métricas</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #ffffff; --text: #1b1f24; --muted: #5d6673; --border: #dde1e6;
  --accent: #2f6fde; --ok: #1f8a4c; --warn: #b7791f; --bad: #c0392b; --chip: #eef1f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111418; --panel: #1a1f25; --text: #e6e9ed; --muted: #9aa4b1; --border: #2c333c;
    --accent: #6ea0ff; --ok: #4cc27f; --warn: #e0a84a; --bad: #ef6f62; --chip: #252c35;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 20px 16px 40px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 15px; margin: 24px 0 8px; }
.muted { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.card .value { font-size: 24px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
.card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--chip); font-size: 12px; }
.s-COMPLETED, .o-SUCCESS { color: var(--ok); }
.s-FAILED, .s-TIMED_OUT, .o-FAILED { color: var(--bad); }
.o-PARTIAL, .s-RUNNING, .s-QUEUED { color: var(--warn); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.card.warn { border-color: var(--warn); box-shadow: inset 4px 0 0 var(--warn); }
.card.warn .value { color: var(--warn); }
.card.bad { border-color: var(--bad); box-shadow: inset 4px 0 0 var(--bad); }
.card.bad .value { color: var(--bad); }
.note { margin: 8px 0 0; font-size: 12px; }
#error { display: none; margin: 12px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--bad); color: var(--bad); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Agent OS · Métricas</h1>
    <span class="muted" id="meta">Cargando…</span>
  </header>
  <div id="error"></div>
  <section class="cards" aria-label="Resumen">
    <div class="card"><div class="label">Runs hoy</div><div class="value" id="c-today">–</div><div class="sub" id="c-today-sub"></div></div>
    <div class="card"><div class="label">Runs 7 días</div><div class="value" id="c-week">–</div><div class="sub" id="c-week-sub"></div></div>
    <div class="card"><div class="label">Coste acumulado</div><div class="value" id="c-cost">–</div><div class="sub" id="c-cost-sub"></div></div>
    <div class="card"><div class="label">Tasa de aceptación</div><div class="value" id="c-accept">–</div><div class="sub" id="c-accept-sub"></div></div>
    <div class="card"><div class="label">Última ejecución</div><div class="value" id="c-last">–</div><div class="sub" id="c-last-sub"></div></div>
  </section>

  <h2>Email</h2>
  <section class="cards" aria-label="Email">
    <div class="card" id="e-today-card"><div class="label">Envíos hoy</div><div class="value" id="e-today">–</div><div class="sub" id="e-today-sub"></div></div>
    <div class="card"><div class="label">Envíos esta semana</div><div class="value" id="e-week">–</div><div class="sub">lunes a domingo</div></div>
    <div class="card"><div class="label">Envíos total</div><div class="value" id="e-total">–</div><div class="sub" id="e-total-sub"></div></div>
    <div class="card"><div class="label">Warm-up</div><div class="value" id="e-phase">–</div><div class="sub" id="e-phase-sub"></div></div>
    <div class="card" id="e-hour-card"><div class="label">Límite IONOS</div><div class="value" id="e-hour">–</div><div class="sub" id="e-hour-sub"></div></div>
  </section>
  <p class="muted note" id="e-note"></p>

  <h2>Por agente y versión</h2>
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Agente</th><th>Versión</th><th class="num">Runs</th><th class="num">Éxito</th><th class="num">Coste medio</th>
      <th class="num">Latencia media</th><th class="num">Veredictos</th><th class="num">Aceptación</th><th class="num">Útil (AC-20)</th><th class="num">Score medio</th>
    </tr></thead>
    <tbody id="agents"><tr><td colspan="10" class="muted">Cargando…</td></tr></tbody>
  </table></div>

  <h2>Últimos 10 runs</h2>
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Creado</th><th>Tarea</th><th>Agente</th><th>Estado</th><th>Outcome</th><th class="num">Coste</th><th class="num">Duración</th><th>Trace</th>
    </tr></thead>
    <tbody id="runs"><tr><td colspan="8" class="muted">Cargando…</td></tr></tbody>
  </table></div>
</main>
<script>
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var tenant = params.get('tenant');
  var headers = tenant ? { 'x-tenant-id': tenant } : {};
  var includeArchived = params.get('include_archived') === 'true';
  var archivedQs = includeArchived ? 'include_archived=true' : '';

  function get(path) {
    return fetch(path, { headers: headers, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(path.split('?')[0] + ' → HTTP ' + r.status);
      return r.json();
    });
  }
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }
  function set(id, text) { document.getElementById(id).textContent = text; }
  function eur(v) { return v === null || v === undefined ? '–' : '€' + Number(v).toFixed(v >= 1 ? 2 : 4); }
  function pct(v) { return v === null || v === undefined ? '–' : (v * 100).toFixed(1) + '%'; }
  function ms(v) {
    if (v === null || v === undefined) return '–';
    if (v < 1000) return Math.round(v) + ' ms';
    if (v < 60000) return (v / 1000).toFixed(1) + ' s';
    return (v / 60000).toFixed(1) + ' min';
  }
  function when(isoText) {
    if (!isoText) return '–';
    var d = new Date(isoText);
    return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function statusLine(byStatus) {
    var keys = Object.keys(byStatus || {});
    return keys.length ? keys.map(function (k) { return k.toLowerCase() + ' ' + byStatus[k]; }).join(' · ') : 'sin runs';
  }

  var now = new Date();
  var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var start7 = new Date(startToday.getTime() - 6 * 86400000);

  Promise.all([
    get('metrics/summary'),
    get('metrics/summary?since=' + encodeURIComponent(startToday.toISOString())),
    get('metrics/summary?since=' + encodeURIComponent(start7.toISOString())),
    get('metrics/agents' + (archivedQs ? '?' + archivedQs : '')),
    get('metrics/runs?limit=10' + (archivedQs ? '&' + archivedQs : ''))
  ]).then(function (res) {
    var all = res[0], today = res[1], week = res[2], agents = res[3], runs = res[4];
    set('meta', 'Tenant ' + all.tenant_id + ' · actualizado ' + now.toLocaleTimeString('es-ES') +
      (includeArchived ? ' · incluye agentes archivados' : ' · sin agentes archivados'));

    set('c-today', today.runs.total);
    set('c-today-sub', statusLine(today.runs.by_status));
    set('c-week', week.runs.total);
    set('c-week-sub', eur(week.cost.total_eur) + ' · ' + week.funnel.hypotheses_created + ' hipótesis nuevas');
    set('c-cost', eur(all.cost.total_eur));
    set('c-cost-sub', 'medio ' + eur(all.cost.avg_per_run_eur) + '/run · ' + all.runs.total + ' runs');
    var fb = all.human_feedback;
    set('c-accept', pct(fb.acceptance_rate));
    set('c-accept-sub', fb.subjects_reviewed + ' revisadas · útil ' + pct(fb.useful_rate));
    if (all.last_run) {
      set('c-last', when(all.last_run.created_at));
      set('c-last-sub', all.last_run.task + ' · ' + all.last_run.status + (all.last_run.outcome ? ' / ' + all.last_run.outcome : ''));
    } else {
      set('c-last', '–');
      set('c-last-sub', 'sin runs');
    }

    renderEmail(all.email);

    var tb = document.getElementById('agents');
    tb.textContent = '';
    if (!agents.items.length) tb.appendChild(rowMsg('Sin ejecuciones', 10));
    agents.items.forEach(function (a) {
      var tr = document.createElement('tr');
      var h = a.human_feedback;
      tr.appendChild(el('td', a.agent_name));
      tr.appendChild(el('td', a.version_label || '–'));
      tr.appendChild(el('td', a.runs, 'num'));
      tr.appendChild(el('td', pct(a.outcome.success_rate), 'num'));
      tr.appendChild(el('td', eur(a.avg_cost_eur), 'num'));
      tr.appendChild(el('td', ms(a.avg_latency_ms), 'num'));
      tr.appendChild(el('td', h.verdicts, 'num'));
      tr.appendChild(el('td', pct(h.acceptance_rate), 'num'));
      tr.appendChild(el('td', pct(h.useful_rate), 'num'));
      tr.appendChild(el('td', h.avg_score === null ? '–' : h.avg_score.toFixed(2), 'num'));
      tb.appendChild(tr);
    });

    var rb = document.getElementById('runs');
    rb.textContent = '';
    if (!runs.items.length) rb.appendChild(rowMsg('Sin runs', 8));
    runs.items.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', when(r.created_at)));
      tr.appendChild(el('td', r.task));
      tr.appendChild(el('td', r.agent + (r.version !== null ? ' v' + r.version : '')));
      var st = el('td'); st.appendChild(el('span', r.status, 'chip s-' + r.status)); tr.appendChild(st);
      var oc = el('td'); oc.appendChild(el('span', r.outcome || '–', 'chip o-' + (r.outcome || 'NONE'))); tr.appendChild(oc);
      tr.appendChild(el('td', eur(r.cost_eur), 'num'));
      tr.appendChild(el('td', ms(r.duration_ms), 'num'));
      var link = el('a', 'JSON');
      link.href = 'task-runs/' + encodeURIComponent(r.id);
      link.target = '_blank';
      link.rel = 'noopener';
      var td = el('td'); td.appendChild(link); tr.appendChild(td);
      rb.appendChild(tr);
    });
  }).catch(function (err) {
    var box = document.getElementById('error');
    box.style.display = 'block';
    box.textContent = 'No se pudieron cargar las métricas: ' + err.message;
    set('meta', 'Error');
  });

  function renderEmail(em) {
    if (!em) { set('e-note', 'Sin datos de email en este runtime.'); return; }
    var w = em.warmup, s = em.sends, h = em.ionos_limit;
    set('e-today', w.target_today === null ? String(s.today) : s.today + ' / ' + w.target_today);
    var sub;
    if (w.exceeded) sub = 'Supera el objetivo del día' + (w.exceeded_event_emitted ? ' · aviso emitido' : '');
    else if (w.target_today === null) sub = w.stage === 'post_warmup' ? 'post warm-up: sin tope blando' : 'antes del warm-up';
    else if (w.rest_day) sub = 'día de descanso (objetivo 0)';
    else sub = 'objetivo del día (ambos buzones) · ' + w.target_per_mailbox + ' por buzón';
    set('e-today-sub', sub);
    document.getElementById('e-today-card').className = 'card' + (w.exceeded ? ' warn' : '');
    set('e-week', s.week);
    set('e-total', s.total);
    set('e-total-sub', s.last_sent_at ? 'último ' + when(s.last_sent_at) : 'sin envíos');
    if (w.stage === 'warmup' && w.phase) {
      set('e-phase', w.phase.label);
      set('e-phase-sub', w.phase.from + ' a ' + w.phase.to + ' · ' + w.phase.plan);
    } else if (w.stage === 'post_warmup') {
      set('e-phase', 'Post warm-up');
      set('e-phase-sub', 'desde ' + w.end + ' · sin tope blando; sube de forma gradual');
    } else {
      set('e-phase', 'Antes del warm-up');
      set('e-phase-sub', 'empieza el ' + w.start);
    }
    set('e-hour', h.last_hour + ' / ' + h.per_hour + ' por hora');
    set('e-hour-sub', 'informativo · ' + h.basis + ' · buzón día ' + h.mailbox_age_days);
    document.getElementById('e-hour-card').className = 'card' + (h.status === 'reached' ? ' bad' : '');
    set('e-note', em.note + ' Día ' + w.date + ' (' + em.timezone + ').');
  }

  function rowMsg(text, cols) {
    var tr = document.createElement('tr');
    var td = el('td', text, 'muted');
    td.colSpan = cols;
    tr.appendChild(td);
    return tr;
  }
})();
</script>
</body>
</html>
`;
