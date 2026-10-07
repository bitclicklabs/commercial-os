/**
 * LIVE, READ-ONLY check against the real IONOS mailbox (IONOS_IMAP_* from the environment or
 * runtime/agent-runtime/.env). Skipped without credentials.
 *
 * Connects with EXAMINE, lists the messages received since the warm-up started, fetches
 * them with BODY.PEEK (nothing is marked as read) and classifies them. It writes NOTHING:
 * not to the mailbox (no \Seen, no move, no delete) and not to Twenty. It prints counters
 * and the addresses that would be added, so a human can review false positives before the
 * scheduled task runs for real.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TWENTY_OBJECTS, twentyClientFromEnv, type TwentyNote } from '../../src/integrations/twenty/index.js';
import { createDefaultToolRegistry, parseToolPolicy, ToolExecutor } from '../../src/tools/index.js';
import { ImapFlowMailboxReader, imapConfigFromEnv, mailboxKey } from '../../src/inbound/imap-mailbox.js';
import { classifyMessage, parseMessage } from '../../src/inbound/unsubscribe-classifier.js';
import { readBajasConfig } from '../../src/agents/bajas-agent.js';
import { desiredBajasVersion } from '../../src/seed/bajas-seed.js';

const imap = imapConfigFromEnv();
if (!imap.ok) console.warn(`[live] IMAP not configured (${imap.missing.join(', ')}); skipping`);

describe.skipIf(!imap.ok)('inbound de bajas LIVE (read-only, no writes)', () => {
  it('connects, lists and classifies without modifying anything', { timeout: 120_000 }, async () => {
    if (!imap.ok) return;
    const cfg = readBajasConfig(desiredBajasVersion().configuration);
    const session = await new ImapFlowMailboxReader(imap.config).open();
    try {
      const uids = await session.searchUids({ since: new Date(`${cfg.initialSince}T00:00:00Z`) });
      const last = uids.slice(-cfg.maxMessagesPerRun);
      const raws = await session.fetch(last, cfg.maxMessageBytes);
      const counts: Record<string, number> = {};
      const bajas: Array<{ uid: number; email: string; signals: string[] }> = [];
      for (const raw of raws) {
        const c = classifyMessage(await parseMessage(raw), cfg.classifier);
        const k = c.kind === 'BAJA' ? 'BAJA' : c.reason;
        counts[k] = (counts[k] ?? 0) + 1;
        if (c.kind === 'BAJA') bajas.push({ uid: raw.uid, email: c.email, signals: c.signals });
      }
      console.log(
        `[live] ${mailboxKey(imap.config)} uidValidity=${session.uidValidity} exists=${session.exists} since=${cfg.initialSince} found=${uids.length} fetched=${raws.length}`,
      );
      console.log(`[live] classification: ${JSON.stringify(counts)}`);
      console.log(`[live] would add (dry run, nothing written): ${JSON.stringify(bajas)}`);
      expect(raws.length).toBe(last.length);
    } finally {
      await session.close();
    }
  });
});

/**
 * update_note against the REAL local Twenty, on a clearly-labelled scratch note
 * ("[TEST] pxos-it ...", never the real suppression list). Never deletes anything.
 * Verifies that PATCHing `bodyV2.markdown` keeps the old content and that Twenty regenerates
 * the BlockNote JSON from it.
 */
const twenty = twentyClientFromEnv();
const twentyAvailable = twenty.isConfigured() && (await twenty.ping());

describe.skipIf(!twentyAvailable)('update_note LIVE (scratch [TEST] note in local Twenty)', () => {
  it('appends at the end, keeps existing lines and is idempotent', async () => {
    const created = await twenty.create<TwentyNote>(TWENTY_OBJECTS.note, {
      title: `[TEST] pxos-it update_note ${randomUUID().slice(0, 8)}`,
      bodyV2: { markdown: 'primera@linea.example — 2026-10-06 — manual' },
    });
    const tools = new ToolExecutor(createDefaultToolRegistry({ twenty }), parseToolPolicy({ tool_policy: ['update_note'] }), {
      tenantId: 'it',
      executionId: `it-${randomUUID()}`,
      agentId: 'it',
      stage: null,
      logger: { info() {}, error() {} },
    }, new AbortController().signal);
    const line = 'nueva@linea.example — 2026-10-07 — baja solicitada (asunto: "Baja")';
    const first = await tools.call('update_note', { noteId: created.id, expectedTitle: created.title, appendLines: [line] });
    expect(first.result).toMatchObject({ status: 'ok', output: { updated: true, appended: [line] } });
    const again = await tools.call('update_note', { noteId: created.id, appendLines: [line] });
    expect(again.result).toMatchObject({ status: 'ok', output: { updated: false, skippedExisting: [line] } });
    const after = await twenty.get<TwentyNote>(TWENTY_OBJECTS.note, created.id);
    console.log(`[live] twenty note ${created.id} markdown=${JSON.stringify(after?.bodyV2?.markdown)}`);
    expect(after?.bodyV2?.markdown?.startsWith('primera@linea.example — 2026-10-06 — manual')).toBe(true);
    expect(after?.bodyV2?.markdown).toContain(line);
    expect(after?.bodyV2?.blocknote ?? '').toContain('nueva@linea.example');
  });
});
