import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ToolExecutor,
  ToolRegistrationError,
  ToolRegistry,
  createDefaultToolRegistry,
  defineTool,
  parseToolPolicy,
  toToolSpec,
  type AgentToolPolicy,
  type RiskLevel,
  type Tool,
} from '../../src/tools/index.js';
import { FakeTwenty } from '../helpers/fake-twenty.js';

function fakeTool(overrides: Partial<Tool> & { id: string; riskLevel?: RiskLevel } = { id: 'echo' }): Tool {
  return defineTool({
    name: overrides.id,
    version: '1.0.0',
    description: 'test tool',
    inputSchema: z.object({ text: z.string().max(10) }),
    outputSchema: z.object({ echoed: z.string() }),
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: [],
    timeoutMs: 1_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: async (input: { text: string }) => ({ status: 'ok', output: { echoed: input.text } }),
    ...overrides,
  } as Tool);
}

const scope = { tenantId: 'publiexpe', executionId: 'exec-1', agentId: 'agent-1', stage: 'PROSPECTOR' };
const policy = (allow: string[], extra: Partial<AgentToolPolicy> = {}): AgentToolPolicy => ({
  allow,
  maxCallsPerExecution: 60,
  maxRiskLevel: 'LOW_WRITE',
  ...extra,
});

describe('ToolRegistry', () => {
  it('never registers DESTRUCTIVE tools, even with NEVER_AUTONOMOUS', () => {
    const r = new ToolRegistry();
    expect(() => r.register(fakeTool({ id: 'delete_company', riskLevel: 'DESTRUCTIVE', approvalPolicy: { mode: 'NEVER_AUTONOMOUS' } }))).toThrow(
      ToolRegistrationError,
    );
    expect(r.get('delete_company')).toBeUndefined();
  });

  it('rejects duplicates, non snake_case ids and side-effecting HIGH_WRITE without approval', () => {
    const r = new ToolRegistry();
    r.register(fakeTool({ id: 'echo' }));
    expect(() => r.register(fakeTool({ id: 'echo' }))).toThrow(/already registered/);
    expect(() => r.register(fakeTool({ id: 'Echo-Tool' }))).toThrow(/snake_case/);
    expect(() => r.register(fakeTool({ id: 'update_opportunity', riskLevel: 'HIGH_WRITE', sideEffects: true }))).toThrow(/approval/);
    r.register(fakeTool({ id: 'send_email', riskLevel: 'EXTERNAL_SIDE_EFFECT', sideEffects: true, approvalPolicy: { mode: 'REQUIRED' } }));
  });

  it('resolve() returns only allowed, enabled tools within the risk ceiling', () => {
    const r = new ToolRegistry();
    r.register(fakeTool({ id: 'read_a' }));
    r.register(fakeTool({ id: 'write_b', riskLevel: 'LOW_WRITE', sideEffects: true }));
    r.register(fakeTool({ id: 'disabled_c', enabled: false }));
    r.register(fakeTool({ id: 'send_d', riskLevel: 'EXTERNAL_SIDE_EFFECT', sideEffects: true, approvalPolicy: { mode: 'REQUIRED' } }));
    const ids = r.resolve(policy(['read_a', 'write_b', 'disabled_c', 'send_d'])).map((t) => t.id);
    expect(ids).toEqual(['read_a', 'write_b']);
    expect(r.resolve(policy(['read_a', 'write_b'], { maxRiskLevel: 'READ' })).map((t) => t.id)).toEqual(['read_a']);
  });

  it('default registry exposes the 7 Twenty tools, fetch_url and render_url with their risk classes', () => {
    const r = createDefaultToolRegistry({ twenty: new FakeTwenty().client() });
    const byId = Object.fromEntries(r.list().map((t) => [t.id, t.riskLevel]));
    expect(byId).toEqual({
      find_company: 'READ',
      get_company: 'READ',
      upsert_company: 'LOW_WRITE',
      create_signal: 'LOW_WRITE',
      create_research: 'LOW_WRITE',
      create_hypothesis: 'LOW_WRITE',
      create_agent_run_summary: 'LOW_WRITE',
      fetch_url: 'READ',
      render_url: 'READ',
    });
    expect(r.get('fetch_url')).toMatchObject({ sideEffects: false, outputTrust: 'untrusted' });
    expect(r.get('render_url')).toMatchObject({ sideEffects: false, outputTrust: 'untrusted', approvalPolicy: { mode: 'NONE' } });
    for (const t of r.list()) {
      expect(t.sideEffects).toBe(t.riskLevel !== 'READ');
      const spec = toToolSpec(t);
      expect(spec.inputSchema).toMatchObject({ type: 'object' });
    }
  });
});

describe('parseToolPolicy', () => {
  it('denies everything when there is no policy', () => {
    expect(parseToolPolicy({})).toEqual({ allow: [], maxCallsPerExecution: 60, maxRiskLevel: 'LOW_WRITE' });
    expect(parseToolPolicy({ tool_policy: 42 }).allow).toEqual([]);
  });

  it('accepts a plain list of tool ids', () => {
    expect(parseToolPolicy({ tool_policy: ['find_company', 'find_company', 'create_signal'] }).allow).toEqual(['find_company', 'create_signal']);
  });

  it('accepts the object form in snake_case or camelCase and never a DESTRUCTIVE ceiling', () => {
    expect(
      parseToolPolicy({ tool_policy: { allow: ['a'], max_calls_per_execution: 5, max_calls_per_tool: { a: 2 }, max_risk_level: 'READ' } }),
    ).toEqual({ allow: ['a'], maxCallsPerExecution: 5, maxCallsPerTool: { a: 2 }, maxRiskLevel: 'READ' });
    expect(parseToolPolicy({ toolPolicy: { allow: ['a'], maxRiskLevel: 'DESTRUCTIVE' } }).maxRiskLevel).toBe('EXTERNAL_SIDE_EFFECT');
  });
});

describe('ToolExecutor', () => {
  const registry = () => {
    const r = new ToolRegistry();
    r.register(fakeTool({ id: 'echo' }));
    r.register(fakeTool({ id: 'write_x', riskLevel: 'LOW_WRITE', sideEffects: true }));
    r.register(fakeTool({ id: 'off', enabled: false }));
    r.register(
      fakeTool({
        id: 'slow',
        timeoutMs: 20,
        execute: (_i: unknown, ctx: { signal: AbortSignal }) =>
          new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ status: 'ok', output: { echoed: 'late' } }))),
      } as Partial<Tool> & { id: string }),
    );
    r.register(fakeTool({ id: 'liar', execute: async () => ({ status: 'ok', output: { wrong: 1 } }) } as Partial<Tool> & { id: string }));
    r.register(fakeTool({ id: 'thrower', execute: async () => { throw new Error('boom'); } } as Partial<Tool> & { id: string }));
    return r;
  };
  const exec = (p: AgentToolPolicy, signal = new AbortController().signal) => new ToolExecutor(registry(), p, scope, signal);

  it('executes an allowed tool and records a TOOL step', async () => {
    const out = await exec(policy(['echo'])).call('echo', { text: 'hola' });
    expect(out.result).toEqual({ status: 'ok', output: { echoed: 'hola' } });
    expect(out.step).toMatchObject({
      type: 'TOOL',
      tool: 'echo',
      toolInput: { text: 'hola' },
      toolOutput: { echoed: 'hola' },
      output: { status: 'ok', riskLevel: 'READ', sourceTrust: 'trusted', idempotencyKey: 'tool:exec-1:echo:1' },
    });
    expect(out.step.error).toBeUndefined();
  });

  it('rejects tools outside the allowlist with TOOL_NOT_ALLOWED and still records the step', async () => {
    const out = await exec(policy(['echo'])).call('write_x', { text: 'x' });
    expect(out.result).toMatchObject({ status: 'error', code: 'TOOL_NOT_ALLOWED' });
    expect(out.step).toMatchObject({ type: 'TOOL', tool: 'write_x', error: { code: 'TOOL_NOT_ALLOWED' } });
  });

  it('rejects unknown, disabled and over-ceiling tools', async () => {
    const e = exec(policy(['echo', 'write_x', 'off', 'ghost'], { maxRiskLevel: 'READ' }));
    expect((await e.call('ghost', {})).result).toMatchObject({ code: 'TOOL_NOT_FOUND' });
    expect((await e.call('off', { text: 'x' })).result).toMatchObject({ code: 'TOOL_DISABLED' });
    expect((await e.call('write_x', { text: 'x' })).result).toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
  });

  it('enforces call limits per execution and per tool', async () => {
    const e = exec(policy(['echo', 'write_x'], { maxCallsPerExecution: 3, maxCallsPerTool: { echo: 1 } }));
    expect((await e.call('echo', { text: 'a' })).result.status).toBe('ok');
    expect((await e.call('echo', { text: 'b' })).result).toMatchObject({ code: 'TOOL_CALL_LIMIT' });
    expect((await e.call('write_x', { text: 'c' })).result.status).toBe('ok');
    expect((await e.call('write_x', { text: 'd' })).result.status).toBe('ok');
    expect((await e.call('write_x', { text: 'e' })).result).toMatchObject({ code: 'TOOL_CALL_LIMIT' });
  });

  it('validates input and output against the zod schemas', async () => {
    const e = exec(policy(['echo', 'liar']));
    const bad = await e.call('echo', { text: 'way too long for the schema' });
    expect(bad.result).toMatchObject({ status: 'error', code: 'INVALID_INPUT' });
    expect((await e.call('liar', { text: 'x' })).result).toMatchObject({ status: 'error', code: 'INVALID_OUTPUT' });
  });

  it('maps timeouts and thrown errors to tool errors', async () => {
    const e = exec(policy(['slow', 'thrower']));
    expect((await e.call('slow', { text: 'x' })).result).toMatchObject({ code: 'TOOL_TIMEOUT', retryable: true });
    expect((await e.call('thrower', { text: 'x' })).result).toMatchObject({ code: 'TOOL_ERROR', message: 'boom' });
  });

  it('propagates execution cancellation', async () => {
    const c = new AbortController();
    c.abort();
    await expect(exec(policy(['echo']), c.signal).call('echo', { text: 'x' })).rejects.toThrow();
  });

  it('specs() lists only the policy-resolved tools', () => {
    expect(exec(policy(['echo', 'off', 'write_x'], { maxRiskLevel: 'READ' })).specs().map((s) => s.name)).toEqual(['echo']);
  });
});
