/**
 * Definition of the Twenty workflow "Commercial OS · Enviar borrador de email" (Twenty 2.45).
 *
 * HITL by design: the runtime never sends. This workflow lives in Twenty, starts ONLY from a
 * manual trigger on one commercialHypothesis record (a person clicks it in the record's
 * command menu) and sends through the mailbox that person connected in Settings → Accounts.
 * The runtime only writes the draft into the hypothesis fields (`set_hypothesis_draft`).
 *
 * Steps (all verified against the 2.45.6 server code inside `pxos-twenty`):
 * 1. FIND_RECORDS: re-reads the hypothesis from the database. The record a manual trigger
 *    carries (`trigger.payload`) is the one the browser had in memory; it can be stale
 *    (an old READY after the email went out, or a body edited in another tab). Every later step reads `first.*`.
 * 2. FILTER: stops the run (`shouldEndWorkflowRun`) unless emailStatus = READY (the person
 *    marked the draft as reviewed), status = VALIDATED and To/Subject/Body are not empty.
 * 3. UPDATE_RECORD emailStatus = SENDING before sending: a second click fails the filter,
 *    and a send that fails leaves SENDING visible (never a false SENT).
 * 4. SEND_EMAIL with the fresh values. The body is an email document whose only node is an
 *    `html` node `<pre …>{{body}}</pre>`: inside an html attribute Twenty HTML-escapes the
 *    variable, and `<pre>` keeps the line breaks in both the HTML and the plain-text part
 *    (a plain string body would be read as HTML and every line break would be lost).
 *    retryOnFailure = 0: a retried send could duplicate an email.
 * 5. UPDATE_RECORD emailStatus = SENT.
 *
 * The sender (`connectedAccountId`) is, by default, the workspace member who clicked
 * (`{{trigger.metadata.workspaceMemberId}}`): Twenty resolves a member id to that member's
 * first connected account able to send (`EmailWorkflowActionBase.resolveSenderConnectedAccountId`).
 * Until that person has a mailbox with SMTP connected, the step fails with "has no connected
 * account that can send email": nothing is sent.
 */

export const SEND_DRAFT_WORKFLOW_NAME = 'Commercial OS · Enviar borrador de email';
export const HYPOTHESIS_OBJECT = 'commercialHypothesis';

/** Values of the `emailStatus` SELECT of commercialHypothesis (Twenty App). */
export const EMAIL_DRAFT_STATUSES = ['DRAFT', 'READY', 'SENDING', 'SENT'] as const;
export type EmailDraftStatus = (typeof EMAIL_DRAFT_STATUSES)[number];

/** Stable ids so a re-created workflow keeps the same variable paths. */
export const SEND_DRAFT_STEP_IDS = {
  find: '73f7524c-3c17-4650-869e-5edc66dba538',
  filter: 'd03281a2-ef22-4021-9690-577d4502dc77',
  markSending: 'ca71fceb-9ffb-40aa-80d7-b4d58026a2ff',
  send: '5561d97c-ca80-4e2a-bf18-6d2f8d7c624d',
  markSent: '3a795ecb-b1f0-40c3-a9ed-ce582596203f',
} as const;

const FILTER_GROUP_ID = '03f4bea7-512b-4fbe-ac21-c23394e3a54c';
const FILTER_IDS = {
  emailStatus: '6bac45e7-53eb-42e7-b02a-79b4e346c09d',
  emailTo: '9747b5a7-cf5c-4f00-bcdf-c6bdb59d2181',
  emailSubject: 'c815ddf1-7fc5-48ea-a15c-5ef45de21932',
  emailBody: 'ddd81fdc-9464-4885-897e-48e005de69ba',
  status: '32d4681d-0c77-429c-a90d-487adfdf8e48',
} as const;
const RECORD_FILTER_GROUP_ID = 'bb019a81-d37f-442e-94e6-da6f0715bdad';
const RECORD_FILTER_ID = 'ddb86cb4-2700-40c3-acb2-0ca63d8b258e';

const NO_RETRY = { retryOnFailure: { value: 0 }, continueOnFailure: { value: false } };

const fresh = (field: string) => `{{${SEND_DRAFT_STEP_IDS.find}.first.${field}}}`;

/** Inline style of the `<pre>` wrapper: normal font, wraps long lines. */
export const BODY_PRE_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;margin:0';

/**
 * Email document (Twenty `EMAIL_DOCUMENT_SCHEMA_VERSION` 1) for the SEND_EMAIL body. The
 * variable sits in an `html` attribute, where Twenty escapes the resolved value.
 */
export function sendDraftEmailBodyDocument(bodyVariable: string = fresh('emailBody')): string {
  return JSON.stringify({
    type: 'doc',
    version: 1,
    content: [{ type: 'html', attrs: { html: `<pre style="${BODY_PRE_STYLE}">${bodyVariable}</pre>` } }],
  });
}

/**
 * Manual trigger context in 2.45 (`buildWorkflowRunTriggerContext`): the selected record
 * spread at the top level and again under `payload`, plus `metadata.workspaceMemberId` of
 * the person who clicked. (The schema description that mentions `trigger.record` is stale.)
 */
export const TRIGGER_RECORD_ID = '{{trigger.payload.id}}';
export const TRIGGER_WORKSPACE_MEMBER_ID = '{{trigger.metadata.workspaceMemberId}}';

export interface SendDraftWorkflowOptions {
  /**
   * Who sends. Default: the workspace member who clicked (`{{trigger.metadata.workspaceMemberId}}`),
   * which Twenty resolves to that member's first send-capable connected account: each person
   * sends from their own mailbox. A fixed connected account id or member id also works.
   */
  senderId?: string;
  /** fieldMetadataId of `commercialHypothesis.id` (FIND_RECORDS filters reference field metadata). */
  hypothesisIdFieldMetadataId: string;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  trigger: Record<string, unknown>;
  steps: Array<Record<string, unknown> & { id: string; type: string }>;
  /** Always false: activating is a human decision taken in the Twenty UI. */
  activate: false;
}

export function buildSendDraftWorkflow(opts: SendDraftWorkflowOptions): WorkflowDefinition {
  const ids = SEND_DRAFT_STEP_IDS;
  const textNotEmpty = (id: string, field: string, position: number) => ({
    id,
    type: 'TEXT',
    stepOutputKey: fresh(field),
    operand: 'IS_NOT_EMPTY',
    value: '',
    stepFilterGroupId: FILTER_GROUP_ID,
    positionInStepFilterGroup: position,
  });
  const selectIs = (id: string, field: string, value: string, position: number) => ({
    id,
    type: 'SELECT',
    stepOutputKey: fresh(field),
    operand: 'IS',
    value: JSON.stringify([value]),
    stepFilterGroupId: FILTER_GROUP_ID,
    positionInStepFilterGroup: position,
  });
  const markStatus = (id: string, name: string, status: EmailDraftStatus, next: string[]) => ({
    id,
    name,
    type: 'UPDATE_RECORD',
    valid: true,
    nextStepIds: next,
    settings: {
      input: {
        objectName: HYPOTHESIS_OBJECT,
        objectRecordId: fresh('id'),
        objectRecord: { emailStatus: status },
        fieldsToUpdate: ['emailStatus'],
      },
      outputSchema: {},
      errorHandlingOptions: NO_RETRY,
    },
  });

  return {
    name: SEND_DRAFT_WORKFLOW_NAME,
    description:
      'Envía, desde el buzón conectado del comercial, el borrador guardado en la hipótesis (campos Email). Solo arranca a mano sobre una hipótesis y solo envía si Email status = Reviewed (READY). Lo crea pnpm twenty:send-workflow en borrador; lo activa una persona.',
    activate: false,
    trigger: {
      name: 'Enviar borrador de email',
      type: 'MANUAL',
      settings: {
        objectType: HYPOTHESIS_OBJECT,
        icon: 'IconSend',
        isPinned: true,
        availability: { type: 'SINGLE_RECORD', objectNameSingular: HYPOTHESIS_OBJECT },
        outputSchema: {},
      },
      nextStepIds: [ids.find],
    },
    steps: [
      {
        id: ids.find,
        name: 'Releer la hipótesis',
        type: 'FIND_RECORDS',
        valid: true,
        nextStepIds: [ids.filter],
        settings: {
          input: {
            objectName: HYPOTHESIS_OBJECT,
            limit: 1,
            filter: {
              recordFilterGroups: [{ id: RECORD_FILTER_GROUP_ID, logicalOperator: 'AND' }],
              recordFilters: [
                {
                  id: RECORD_FILTER_ID,
                  type: 'UUID',
                  label: 'Id',
                  value: TRIGGER_RECORD_ID,
                  displayValue: TRIGGER_RECORD_ID,
                  operand: 'IS',
                  fieldMetadataId: opts.hypothesisIdFieldMetadataId,
                  recordFilterGroupId: RECORD_FILTER_GROUP_ID,
                },
              ],
            },
          },
          outputSchema: {},
          errorHandlingOptions: NO_RETRY,
        },
      },
      {
        id: ids.filter,
        name: 'Solo si está Revisado y completo',
        type: 'FILTER',
        valid: true,
        nextStepIds: [ids.markSending],
        settings: {
          input: {
            stepFilterGroups: [{ id: FILTER_GROUP_ID, logicalOperator: 'AND' }],
            stepFilters: [
              selectIs(FILTER_IDS.emailStatus, 'emailStatus', 'READY', 0),
              selectIs(FILTER_IDS.status, 'status', 'VALIDATED', 1),
              textNotEmpty(FILTER_IDS.emailTo, 'emailTo', 2),
              textNotEmpty(FILTER_IDS.emailSubject, 'emailSubject', 3),
              textNotEmpty(FILTER_IDS.emailBody, 'emailBody', 4),
            ],
          },
          outputSchema: {},
          errorHandlingOptions: NO_RETRY,
        },
      },
      markStatus(ids.markSending, 'Marcar Enviando', 'SENDING', [ids.send]),
      {
        id: ids.send,
        name: 'Enviar email',
        type: 'SEND_EMAIL',
        valid: true,
        nextStepIds: [ids.markSent],
        settings: {
          input: {
            connectedAccountId: opts.senderId ?? TRIGGER_WORKSPACE_MEMBER_ID,
            recipients: { to: fresh('emailTo'), cc: '', bcc: '' },
            subject: fresh('emailSubject'),
            body: sendDraftEmailBodyDocument(),
            files: [],
          },
          outputSchema: {},
          errorHandlingOptions: NO_RETRY,
        },
      },
      markStatus(ids.markSent, 'Marcar Enviado', 'SENT', []),
    ],
  };
}
