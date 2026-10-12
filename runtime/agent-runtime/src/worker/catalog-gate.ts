/**
 * Catalog health gate and degraded mode (contract v1.1, "Disponibilidad y modo degradado").
 *
 * Before an execution whose tool policy can use the catalog (`policyRequiresCatalog`), the worker
 * asks the gate. The gate reads the connector's `/health` through the shared CatalogService
 * (cached 60 s). It NEVER holds or fails the run:
 *
 * - CATALOG_ENABLED=false: nothing to check (the catalog tools are not even exposed).
 * - healthy (`ok`, or `degraded`, which is informative only): the run uses the catalog.
 * - down (no answer, network error, 503, 401/403, unknown contract MAJOR): the run goes on
 *   WITHOUT catalog (the tools answer CATALOG_UNAVAILABLE and the agent falls back to generic
 *   product families) and, at most once a day per tenant (Europe/Madrid day):
 *     1. the event `catalog.unavailable` on the event bus (idempotency key per tenant and day,
 *        so a second worker or a restart does not publish it twice), for n8n to route;
 *     2. one ⚠️ Twenty TASK (tanda 19; before, a note) "Catálogo no disponible — <día> (<tenant>)",
 *        status TODO, due today (idempotent by title + day: an existing task is reused, never
 *        duplicated or edited).
 *   Never an email: the runtime does not send mail by principle.
 */
import type { TwentyClient } from '../integrations/twenty/index.js';
import { createCrmTask, crmTaskTitle } from '../integrations/twenty/tasks.js';
import { defaultCatalogService, type CatalogAvailability, type CatalogService } from '../integrations/catalog/index.js';
import { twentyClientFromEnv } from '../integrations/twenty/index.js';
import { NOOP_EVENT_PUBLISHER, type EventPublisher } from '../events/event-bus.js';
import type { CatalogEventType } from '../events/envelope.js';
import type { AgentToolPolicy, ToolRegistry } from '../tools/index.js';

export const CATALOG_UNAVAILABLE_EVENT: CatalogEventType = 'catalog.unavailable';
export const CATALOG_GATE_TIMEZONE = 'Europe/Madrid';

/** True if a tool the policy really lets the agent call (allowlisted, enabled, within the risk ceiling) reads the catalog. */
export function policyRequiresCatalog(registry: ToolRegistry, policy: AgentToolPolicy): boolean {
  return registry.resolve(policy).some((tool) => tool.permissions.some((p) => p.startsWith('catalog:')));
}

export interface CatalogGateLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silent: CatalogGateLogger = { info() {}, warn() {}, error() {} };

export type CatalogGateResult =
  | { checked: false; reason: 'not_required' | 'disabled' }
  | {
      checked: true;
      available: boolean;
      availability: CatalogAvailability;
      /** Only when unavailable: what was done about it today. */
      notice?: { day: string; alreadyNotified: boolean; eventPublished: boolean; taskId: string | null; taskCreated: boolean; taskError?: string };
    };

export interface CatalogGateOptions {
  catalog: CatalogService;
  /** Twenty for the ⚠️ task; null or unconfigured = event only. */
  twenty: TwentyClient | null;
  /** Read at call time (the processor's `events` is set after construction). */
  events?: () => EventPublisher;
  logger?: CatalogGateLogger;
  now?: () => Date;
  timeZone?: string;
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export function localDay(date: Date, timeZone = CATALOG_GATE_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function catalogUnavailableNoteTitle(day: string, tenantId: string): string {
  return crmTaskTitle(`⚠️ Catálogo no disponible — ${day} (${tenantId})`);
}

export function catalogUnavailableNoteMarkdown(a: { day: string; tenantId: string; availability: Extract<CatalogAvailability, { available: false }>; provider: string | null }): string {
  return [
    `El catálogo de publiexpe **no estuvo disponible** al empezar una ejecución de hoy (${a.day}).`,
    '',
    '**Qué significa para ti:** las hipótesis de hoy salen con **familias genéricas** de producto (por ejemplo, «bolsas tote» o «bolígrafos») en lugar de productos con referencia. Siguen siendo válidas para revisar: no tienes que hacer nada. Cuando el catálogo vuelva, las ejecuciones siguientes lo usarán solas.',
    '',
    '**Para quien opera el runtime:**',
    '',
    `- Motivo: \`${a.availability.code}\` (${a.availability.reason}). ${a.availability.message.slice(0, 300)}`,
    `- Proveedor configurado: ${a.provider ?? '(ninguno)'} · tenant: ${a.tenantId} · comprobado: ${a.availability.checkedAt}`,
    '- Comprueba que la VPN está arriba y que el host de `CATALOG_BASE_URL` responde a `/api/catalog/v1/health` (un 401 o 403 apunta a un token caducado o a una IP fuera del rango permitido).',
    '- Estado visto por el runtime: `GET /catalog/health` de la API del runtime.',
    '- Si hace falta, apaga el catálogo con `CATALOG_ENABLED=false` mientras tanto (docs/catalog-service.md).',
    '',
    'Este aviso se deja como mucho una vez al día. No se envía ningún correo.',
  ].join('\n');
}

export class CatalogGate {
  private readonly catalog: CatalogService;
  private readonly twenty: TwentyClient | null;
  private readonly events: () => EventPublisher;
  private readonly logger: CatalogGateLogger;
  private readonly now: () => Date;
  private readonly timeZone: string;
  /** `${tenant}:${day}` already notified by this process (fast path; the event key and the note title cover other processes). */
  private readonly notified = new Set<string>();
  /** `${tenant}:${day}` whose event THIS process published (a failed note is retried by its next run). */
  private readonly ownEvents = new Set<string>();
  /** Serialises the notification per tenant and day (concurrent runs of the same worker). */
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(opts: CatalogGateOptions) {
    this.catalog = opts.catalog;
    this.twenty = opts.twenty;
    this.events = opts.events ?? (() => NOOP_EVENT_PUBLISHER);
    this.logger = opts.logger ?? silent;
    this.now = opts.now ?? (() => new Date());
    this.timeZone = opts.timeZone ?? CATALOG_GATE_TIMEZONE;
  }

  /** Never throws. */
  async beforeRun(args: { tenantId: string; executionId: string; requiresCatalog: boolean }): Promise<CatalogGateResult> {
    if (!args.requiresCatalog) return { checked: false, reason: 'not_required' };
    if (!this.catalog.enabled) return { checked: false, reason: 'disabled' };
    const availability = await this.catalog.availability();
    if (availability.available) {
      if (availability.degraded) this.logger.info({ executionId: args.executionId, health: availability.health }, 'catalog health is degraded (informative): the run uses the catalog');
      return { checked: true, available: true, availability };
    }
    this.logger.warn({ executionId: args.executionId, code: availability.code, reason: availability.reason }, 'catalog unavailable: the run goes on without catalog');
    const day = localDay(this.now(), this.timeZone);
    const key = `${args.tenantId}:${day}`;
    if (this.notified.has(key)) {
      return { checked: true, available: false, availability, notice: { day, alreadyNotified: true, eventPublished: false, taskId: null, taskCreated: false } };
    }
    const running = this.pending.get(key);
    if (running) {
      await running.catch(() => undefined);
      return { checked: true, available: false, availability, notice: { day, alreadyNotified: true, eventPublished: false, taskId: null, taskCreated: false } };
    }
    const work = this.notify(args, availability, day, key);
    this.pending.set(key, work);
    try {
      return { checked: true, available: false, availability, notice: await work };
    } finally {
      this.pending.delete(key);
    }
  }

  private async notify(
    args: { tenantId: string; executionId: string },
    availability: Extract<CatalogAvailability, { available: false }>,
    day: string,
    key: string,
  ): Promise<NonNullable<Extract<CatalogGateResult, { checked: true }>['notice']>> {
    const published = await this.events().emit({
      tenantId: args.tenantId,
      type: CATALOG_UNAVAILABLE_EVENT,
      correlationId: args.executionId,
      producer: 'agent-runtime',
      idempotencyKey: `evt:${CATALOG_UNAVAILABLE_EVENT}:${args.tenantId}:${day}`,
      data: {
        day,
        reason: availability.reason,
        code: availability.code,
        message: availability.message.slice(0, 500),
        provider: this.catalog.api?.kind ?? null,
        checkedAt: availability.checkedAt,
        executionId: args.executionId,
      },
    });
    if (published?.created) this.ownEvents.add(key);
    // Another process already published today's event: it also owns today's note.
    const alreadyByOther = published !== null && !published.created && !this.ownEvents.has(key);
    let taskId: string | null = null;
    let taskCreated = false;
    let taskError: string | undefined;
    if (!alreadyByOther && this.twenty?.isConfigured()) {
      try {
        // A Twenty Task due today (tanda 19; before, a note). The title already carries the day
        // and the tenant, so it is matched by title alone (`scope: 'ever'`): one per tenant and day,
        // whatever the clock of the Twenty server says about its creation day.
        const task = await createCrmTask(
          this.twenty,
          {
            title: catalogUnavailableNoteTitle(day, args.tenantId),
            body: catalogUnavailableNoteMarkdown({ day, tenantId: args.tenantId, availability, provider: this.catalog.api?.kind ?? null }),
            dueAt: day,
            scope: 'ever',
          },
          { now: this.now(), timeZone: this.timeZone },
        );
        taskId = task.taskId;
        taskCreated = task.created;
      } catch (err) {
        taskError = err instanceof Error ? err.message : String(err);
        this.logger.error({ executionId: args.executionId, err: taskError }, 'could not leave the catalog-unavailable task in Twenty');
      }
    }
    // A failed task is retried by the next run of the day (the event is deduplicated by its key).
    if (taskError === undefined) this.notified.add(key);
    return { day, alreadyNotified: alreadyByOther, eventPublished: published?.created === true, taskId, taskCreated, ...(taskError ? { taskError } : {}) };
  }
}

/** Gate over the process-wide CatalogService and the env-configured Twenty. */
export function catalogGateFromEnv(opts: Partial<CatalogGateOptions> = {}): CatalogGate {
  return new CatalogGate({ catalog: opts.catalog ?? defaultCatalogService(), twenty: opts.twenty === undefined ? twentyClientFromEnv() : opts.twenty, ...opts });
}
