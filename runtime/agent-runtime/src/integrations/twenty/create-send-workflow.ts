/**
 * `pnpm twenty:send-workflow [--apply] [--sender <workspaceMemberId|connectedAccountId>]`
 *
 * Creates in Twenty 2.45, as a DRAFT that is NEVER activated by this script, the workflow
 * "Commercial OS · Enviar borrador de email" (definition in `send-draft-workflow.ts`).
 *
 * - Without `--apply` (default) it is a dry run: it checks that the Twenty App fields exist
 *   (`emailTo`, `emailSubject`, `emailBody`, `emailStatus` on commercialHypothesis), looks for
 *   an existing workflow with the same name and prints the definition. Writes nothing.
 * - With `--apply` it creates the workflow through the Twenty MCP endpoint
 *   (`execute_tool` → `create_complete_workflow`, `activate: false`) and runs
 *   `validate_workflow`, which only reports whether the version could be activated.
 *   If a workflow with that name already exists it does nothing (edit it in the UI).
 *
 * Activating the workflow is a human decision taken in Twenty (Workflows → the workflow →
 * Activate) after the mailbox is connected. This script has no option to activate.
 *
 * Needs TWENTY_API_KEY (and TWENTY_BASE_URL, default http://localhost:3020) with permission
 * to manage workflows. Run it BEFORE restricting the runtime API key role (see
 * docs/twenty-envio-email.md), or with a key of a person.
 */
import { parseArgs } from 'node:util';
import { HYPOTHESIS_OBJECT, SEND_DRAFT_WORKFLOW_NAME, buildSendDraftWorkflow, type WorkflowDefinition } from './send-draft-workflow.js';

export const REQUIRED_HYPOTHESIS_FIELDS = ['emailTo', 'emailSubject', 'emailBody', 'emailStatus'] as const;

interface MetadataField {
  id: string;
  name: string;
  type: string;
}
interface MetadataObject {
  id: string;
  nameSingular: string;
  fields?: MetadataField[];
}

export interface SendWorkflowOptions {
  baseUrl: string;
  apiKey: string;
  apply: boolean;
  senderId?: string;
  fetch?: typeof fetch;
}

export type SendWorkflowResult =
  | { action: 'dry-run'; missingFields: string[]; existingWorkflowId: string | null; definition: WorkflowDefinition }
  | { action: 'exists'; existingWorkflowId: string }
  | { action: 'created'; result: unknown; validation: unknown }
  | { action: 'blocked'; reason: string; missingFields: string[] };

/** Parses a JSON or an SSE (`event: message` / `data: {...}`) MCP response. */
export function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  if (data.length === 0) throw new Error(`unexpected MCP response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(data);
}

/** The text payload of an MCP `tools/call` result, parsed as JSON when possible. */
export function mcpToolResult(response: unknown): unknown {
  const r = response as { error?: { message?: string }; result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean } };
  if (r.error) throw new Error(`MCP error: ${r.error.message ?? JSON.stringify(r.error)}`);
  const text = r.result?.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function createSendWorkflow(opts: SendWorkflowOptions): Promise<SendWorkflowResult> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.baseUrl.replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${opts.apiKey}` };
  const getJson = async (path: string): Promise<unknown> => {
    const res = await f(`${base}${path}`, { headers: { ...auth, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Twenty GET ${path} failed with ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  };
  let rpcId = 0;
  const callTool = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await f(`${base}/mcp`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'execute_tool', arguments: { toolName, arguments: args } } }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Twenty MCP ${toolName} failed with ${res.status}: ${text.slice(0, 300)}`);
    return mcpToolResult(parseMcpResponse(text));
  };

  // 1. Field metadata of commercialHypothesis.
  const objectsJson = (await getJson('/rest/metadata/objects?limit=200')) as { data?: unknown };
  const objects = (Array.isArray(objectsJson.data) ? objectsJson.data : ((objectsJson.data as { objects?: unknown })?.objects ?? [])) as MetadataObject[];
  const hypothesis = objects.find((o) => o.nameSingular === HYPOTHESIS_OBJECT);
  if (!hypothesis) throw new Error(`object ${HYPOTHESIS_OBJECT} not found: is the Twenty App installed?`);
  const fields = hypothesis.fields ?? [];
  const idField = fields.find((x) => x.name === 'id');
  if (!idField) throw new Error(`${HYPOTHESIS_OBJECT}.id field metadata not found`);
  const missingFields = REQUIRED_HYPOTHESIS_FIELDS.filter((n) => !fields.some((x) => x.name === n));

  // 2. Existing workflow with the same name (never duplicated, never modified).
  const filter = encodeURIComponent(`name[eq]:"${SEND_DRAFT_WORKFLOW_NAME}"`);
  const wfJson = (await getJson(`/rest/workflows?filter=${filter}&limit=5`)) as { data?: { workflows?: Array<{ id: string; name: string; deletedAt?: string | null }> } };
  const existing = (wfJson.data?.workflows ?? []).find((w) => w.name === SEND_DRAFT_WORKFLOW_NAME && !w.deletedAt) ?? null;

  const definition = buildSendDraftWorkflow({
    hypothesisIdFieldMetadataId: idField.id,
    ...(opts.senderId ? { senderId: opts.senderId } : {}),
  });

  if (!opts.apply) return { action: 'dry-run', missingFields, existingWorkflowId: existing?.id ?? null, definition };
  if (existing) return { action: 'exists', existingWorkflowId: existing.id };
  if (missingFields.length > 0) {
    return { action: 'blocked', reason: 'sincroniza primero la Twenty App (faltan campos en commercialHypothesis)', missingFields };
  }

  // 3. Create as draft. `activate` is hard-coded to false in the definition.
  const result = await callTool('create_complete_workflow', {
    name: definition.name,
    description: definition.description,
    trigger: definition.trigger,
    steps: definition.steps,
    activate: false,
  });
  const created = result as { success?: boolean; result?: { coreWorkflowVersionId?: string }; error?: string };
  if (created.success === false) throw new Error(`create_complete_workflow failed: ${created.error ?? JSON.stringify(result)}`);
  const versionId = created.result?.coreWorkflowVersionId;
  const validation = versionId ? await callTool('validate_workflow', { coreWorkflowVersionId: versionId }) : null;
  return { action: 'created', result, validation };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false }, sender: { type: 'string' } } });
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) throw new Error('TWENTY_API_KEY is not set');
  const out = await createSendWorkflow({
    baseUrl: process.env.TWENTY_BASE_URL || 'http://localhost:3020',
    apiKey,
    apply: values.apply,
    ...(values.sender ? { senderId: values.sender } : {}),
  });
  console.log(JSON.stringify(out, null, 2));
}

const invokedDirectly = process.argv[1] !== undefined && /create-send-workflow\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
