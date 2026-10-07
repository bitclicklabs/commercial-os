/**
 * Skills that were prompts versioned in code during MVP-0. Since MVP-1 the source of truth
 * is the database (`skills` / `skill_versions`); these constants are only:
 * - the content of v1 the seed writes when the skill does not exist yet (`seedSkills`), and
 * - the fallback an agent uses when the skill cannot be resolved from the database.
 * Do not evolve a skill by editing its constant: create a new version through the API.
 */
import { EMAIL_DRAFTER_SKILL_ID, EMAIL_DRAFTER_SKILL_VERSION, EMAIL_DRAFTER_SYSTEM_PROMPT } from '../agents/email-drafter-prompt.js';
import {
  SCOUT_EXTRACT_SKILL_ID,
  SCOUT_EXTRACT_SYSTEM_PROMPT,
  SCOUT_SEARCH_SYSTEM_PROMPT,
  SCOUT_SKILL_ID,
  SCOUT_SKILL_VERSION,
} from '../agents/event-scout-prompt.js';
import { PROSPECTOR_SKILL_ID, PROSPECTOR_SKILL_VERSION, PROSPECTOR_SYSTEM_PROMPT } from '../agents/prospector-prompt.js';

export interface CodeSkill {
  name: string;
  description: string;
  domain: string;
  text: string;
  /** Where the constant lives and which MVP-0 skill ref (`skill_id` + code version) it was. */
  source: { file: string; constant: string; legacy_skill_id: string; legacy_version: number };
}

export const CODE_SKILLS: readonly CodeSkill[] = [
  {
    name: PROSPECTOR_SKILL_ID,
    description: 'Prospector: decide si un expositor de un evento es relevante para PubliEXPE y redacta la hipótesis comercial (JSON).',
    domain: 'prospecting',
    text: PROSPECTOR_SYSTEM_PROMPT,
    source: { file: 'src/agents/prospector-prompt.ts', constant: 'PROSPECTOR_SYSTEM_PROMPT', legacy_skill_id: PROSPECTOR_SKILL_ID, legacy_version: PROSPECTOR_SKILL_VERSION },
  },
  {
    name: SCOUT_SKILL_ID,
    description: 'Prospector (modo scout): localiza ferias profesionales reales y próximas con la búsqueda de Google (grounding).',
    domain: 'prospecting',
    text: SCOUT_SEARCH_SYSTEM_PROMPT,
    source: { file: 'src/agents/event-scout-prompt.ts', constant: 'SCOUT_SEARCH_SYSTEM_PROMPT', legacy_skill_id: SCOUT_SKILL_ID, legacy_version: SCOUT_SKILL_VERSION },
  },
  {
    name: SCOUT_EXTRACT_SKILL_ID,
    description: 'Prospector (modo scout): extrae los expositores del texto de una página, PDF o catálogo de una feria.',
    domain: 'prospecting',
    text: SCOUT_EXTRACT_SYSTEM_PROMPT,
    source: { file: 'src/agents/event-scout-prompt.ts', constant: 'SCOUT_EXTRACT_SYSTEM_PROMPT', legacy_skill_id: SCOUT_SKILL_ID, legacy_version: SCOUT_SKILL_VERSION },
  },
  {
    name: EMAIL_DRAFTER_SKILL_ID,
    description: 'EmailDrafter: borrador del primer email de contacto tras validar una hipótesis (asunto y cuerpo; nunca se envía).',
    domain: 'outreach',
    text: EMAIL_DRAFTER_SYSTEM_PROMPT,
    source: { file: 'src/agents/email-drafter-prompt.ts', constant: 'EMAIL_DRAFTER_SYSTEM_PROMPT', legacy_skill_id: EMAIL_DRAFTER_SKILL_ID, legacy_version: EMAIL_DRAFTER_SKILL_VERSION },
  },
];

export function codeSkill(name: string): CodeSkill | undefined {
  return CODE_SKILLS.find((s) => s.name === name);
}
