import { riskRank, type AgentToolPolicy, type AnyTool } from './types.js';

export class ToolRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistrationError';
  }
}

const TOOL_ID_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * In-process tool registry (LLD v0.2 section 5.2).
 *
 * Registration rules:
 * - ids are snake_case and unique;
 * - DESTRUCTIVE tools are never registered in MVP-0 (stricter than the LLD rule,
 *   which would allow them with NEVER_AUTONOMOUS: no such tool exists in MVP-0);
 * - a side-effecting tool at HIGH_WRITE or above needs an approval policy other than NONE.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (!TOOL_ID_RE.test(tool.id)) throw new ToolRegistrationError(`Tool id must be snake_case: "${tool.id}"`);
    if (this.tools.has(tool.id)) throw new ToolRegistrationError(`Tool already registered: ${tool.id}`);
    if (tool.riskLevel === 'DESTRUCTIVE') {
      throw new ToolRegistrationError(`DESTRUCTIVE tools cannot be registered (${tool.id})`);
    }
    if (tool.sideEffects && riskRank(tool.riskLevel) >= riskRank('HIGH_WRITE') && tool.approvalPolicy.mode === 'NONE') {
      throw new ToolRegistrationError(`Tool ${tool.id} (${tool.riskLevel}) with side effects requires an approval policy`);
    }
    if (!(tool.timeoutMs > 0)) throw new ToolRegistrationError(`Tool ${tool.id} needs a positive timeoutMs`);
    this.tools.set(tool.id, tool);
  }

  get(id: string): AnyTool | undefined {
    return this.tools.get(id);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** Only the enabled tools the agent policy allows, within its risk ceiling. */
  resolve(policy: AgentToolPolicy): AnyTool[] {
    const allowed = new Set(policy.allow);
    return this.list().filter(
      (t) => allowed.has(t.id) && t.enabled && riskRank(t.riskLevel) <= riskRank(policy.maxRiskLevel),
    );
  }
}
