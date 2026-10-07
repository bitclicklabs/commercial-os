// Identificadores universales estables de los campos (incluidos los dos lados de cada relación).
// Centralizados aquí para evitar imports circulares entre objetos y relaciones.

export const COMMERCIAL_SIGNAL_FIELD_IDS = {
  name: 'e7fe9c90-3577-41dd-a9dd-d2670ce35a29',
  description: 'd3314f16-b0a4-4072-a9f9-83bdda322c40',
  signalType: '4d6793f5-4791-4138-ac36-b72d736b5a61',
  sourceUrl: 'd9d697d5-11ce-43cb-9883-105f52b9f961',
  sourceDomain: 'e1868058-ed8d-47b0-a0b1-a091c53cfb7f',
  detectedAt: '4f0ed6b9-cc69-40bd-b79c-923d4ad7b012',
  eventDate: '374f527b-4319-48f7-95ee-843948cef123',
  confidence: 'd514d943-d94e-485b-8ab3-292476e0a781',
  status: '36f7e8bc-f423-4641-ad6c-8f1e91eaeaef',
  tenantId: '4e351ece-d966-4c89-885e-c3c13a3e1ce9',
  company: '3665c4ef-a4f3-48e9-976d-672e2ca9e0e3',
  researches: 'a9c50eb8-c453-43db-bcdf-b8d11d43748a',
  commercialHypotheses: 'd10e9384-afa0-4144-aa6f-c6a0ee97914d',
} as const;

export const RESEARCH_FIELD_IDS = {
  name: 'c05bb740-1636-450d-95e8-5bf9dc261eb9',
  researchType: 'e2383290-94dd-46f6-944a-46e8dea0a518',
  query: '4b2e5713-d0d7-43c4-b1d3-c0f87a5f82e6',
  summary: 'e0d4e0e4-86c7-4a18-836f-5aabd3c5b828',
  structuredResult: 'ab9cd267-3dc0-48db-8e64-a2ca88adbc68',
  sources: 'efc537cb-4a8b-4287-a57b-ff56cd7cd2f5',
  confidence: 'e9e949cb-2a64-46ed-b167-4adeb76dc7b6',
  agentExecutionId: '7c8a3eaf-59c0-41fc-89ef-0739d308e44e',
  tenantId: 'ece3a45a-6cbf-481a-863f-ba86af835045',
  company: '4be9ffb2-2a1a-4844-9332-29b849aed034',
  commercialSignal: '684d1f20-b1de-4a8c-b872-4bf60961111a',
} as const;

export const COMMERCIAL_HYPOTHESIS_FIELD_IDS = {
  name: 'c658f773-2d86-449a-9b14-44d56c471704',
  need: 'd0a5b136-7dea-453d-971f-d3f23aae699c',
  whyNow: 'e3c536f5-e137-4c85-8e83-2c81322b836a',
  quantityMin: '794001ef-f361-4c0d-8043-260dd56cbd67',
  quantityMax: '4abc967e-786a-48bb-9891-eecf1cb2508d',
  budgetMin: 'e60843c4-115a-4cc1-815c-09fbb4c1948e',
  budgetMax: '96d3d9f2-cbb0-458e-b33a-06c2a2e88b42',
  recommendedProducts: '3c2398a8-8708-41db-9f55-3f0913de3fa6',
  timing: '66383a6d-2a1d-4fac-9f1b-f492308e8d58',
  confidence: '78890226-73b1-42ed-bd8b-b7c9e75a468e',
  evidence: '2de349e9-3f6b-47cc-9421-d034be04f86e',
  status: '115ce2d3-1bf0-48de-85dd-d29a31c1bcf2',
  tenantId: 'b5ee41b4-ce3b-4bd3-91e9-732146acc183',
  company: '5d397a52-7b85-4e35-ad3c-3ed7868909fd',
  commercialSignal: '93bc0e3e-4d8c-424d-85f9-56401d0e3e15',
  decisionMaker: '71d255d6-fdfd-4fb9-ac7d-7cb3a81f7e33',
  // Email draft fields (send-from-Twenty flow, docs/twenty-envio-email.md).
  emailTo: 'cbf36652-2387-430c-8642-d57135858897',
  emailSubject: '63fecdc5-dab9-4a80-91a1-76b34cef3d32',
  emailBody: '6719aadd-92cc-4133-85e5-d1f776d80854',
  emailStatus: '2872782f-4712-498e-a80f-2df15cb5b51f',
} as const;

export const AGENT_RUN_SUMMARY_FIELD_IDS = {
  name: '70b88855-bb52-4d8f-a0b7-6fd6228601ee',
  task: 'bb1be307-7ecf-47ec-8012-9aaea96d5234',
  agentName: 'e2b72c3b-d291-4552-8db4-88dff850010e',
  agentVersion: '28537933-b77d-4bd0-8d2c-4af2f684fc89',
  outcome: '6a477c98-bc6d-41e8-9963-b329e26e2f21',
  resultSummary: '2820d78e-2272-4f5c-a9ef-d0b1718d776c',
  cost: '48a5bc6d-9fde-4fbc-8c8f-18b828717c60',
  traceUrl: '5f9d22c9-b458-4829-8a8b-9b0f9f4c477e',
  agentExecutionId: '43dea082-f74f-459f-97ad-9008620aa58d',
  startedAt: 'f1f263be-debd-4807-a9da-ce55e7ca97ce',
  finishedAt: '844487e3-df1b-407f-8555-87d2244746ba',
  tenantId: '1ae007b3-55d8-4db1-ab65-fe2fd1f2ac96',
  company: '8017a78b-ce36-40e5-b87d-d793ad69748a',
} as const;

// Métricas diarias del Agent OS: un registro por tenant y día local (Europe/Madrid).
export const AGENT_OS_DAILY_METRIC_FIELD_IDS = {
  name: 'd51ace14-b7bb-47a0-8427-6e3c7b401d9e',
  day: '8dfbb313-bc1d-4289-a556-a7741ed9b987',
  dayKey: '29e23eed-ebf0-431c-b08a-f7b89f00575f',
  tenantId: '554a5a2c-0ee3-45f1-bad3-fc1646392dab',
  runs: 'ff59e8b2-ed43-4eaa-a2ad-b7645e496aae',
  runsSucceeded: '9eda5bec-2a7b-44e8-a19b-d2991f953085',
  runsFailed: 'fde24102-ca4e-49c6-bd0f-af1e8ce54a85',
  cost: 'd1bb4b01-ae6e-449b-aa28-a2adf192e98d',
  hypothesesCreated: 'ee26664e-1829-45bd-8ade-8f3c617d24f6',
  emailSends: '7b6dd355-f5e7-408f-8979-4569d820ab69',
  warmupTarget: '8c71cfdd-25f0-4dbd-a6dd-96edbf1c40c5',
  warmupStage: '8847a209-0af5-45ba-b30f-258241567dc1',
  warmupPhase: 'f408ca2c-514b-40bb-a5f8-2888e5c717a2',
  humanReviewed: 'b9223a2b-cdc5-4245-a47a-795f8e03d4ca',
  humanAccepted: '6361bb97-a41c-4e89-8b5c-bb30a82cbfbc',
  acceptanceRate: 'c3c21692-fc77-4b36-883d-58e7d3f58e63',
  syncedAt: 'c81f11fd-44b6-4981-8d19-eca446c25b1c',
} as const;

export const COMPANY_REVERSE_FIELD_IDS = {
  commercialSignals: '6296fa4d-55b3-414f-9ee8-fd126d63cc5a',
  researches: '2e116fbf-34ba-4e85-aee9-a903aa8aaa43',
  commercialHypotheses: 'a746dfa5-0dd5-435e-be26-f3eb1a9d9615',
  agentRunSummaries: 'dbca3cad-9b80-4af8-88b3-870b37480f1d',
} as const;

export const PERSON_REVERSE_FIELD_IDS = {
  decisionMakerHypotheses: '8404a15e-156a-4179-98b3-01e5152874ed',
} as const;
