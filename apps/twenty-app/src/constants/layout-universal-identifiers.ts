// Identificadores universales estables de navegación y vistas.

export const NAVIGATION_MENU_ITEM_IDS = {
  commercialOsFolder: 'f15b2314-7d6f-4c44-8fa7-b9070a6b06e1',
  signals: '8059bbb7-a3b1-49a1-9440-6a5f6a2d2a07',
  research: '84a47967-2b4c-4153-a861-aa628b648729',
  hypotheses: '3d63d987-89ae-44e7-a866-559678465ec0',
  agentRuns: '766b174f-2f94-4aa5-bda9-4d2b7987e4d5',
  metrics: '9d7274c9-3e08-44d4-932f-679638fa387f',
  runtimeDashboard: 'aaac1eab-e639-43ad-a9dd-88859a5f3515',
} as const;

// Página «Agent OS · Métricas» (STANDALONE_PAGE con widgets nativos).
export const METRICS_PAGE_IDS = {
  pageLayout: 'ecd28c68-29e3-444e-bf5c-0a010bf9ec2a',
  tab: '4d5e9658-f19f-4868-98db-b7e00ab91997',
  widgetRunsToday: 'b5076cec-f682-419d-8ea1-08cad32b957e',
  widgetRuns7d: 'b344d2b7-d891-42f7-b8b8-cf3786990e53',
  widgetCostToday: '051ff1ef-2118-4059-b019-466f86eacb7c',
  widgetCost7d: '25c1c480-097d-48e8-818e-1a2de333a988',
  widgetAcceptance: 'd3d53153-a2be-43a3-9bfa-e98090d044d2',
  widgetSendsToday: 'e7cbd975-ad75-4c88-8ca6-6d0894a486ba',
  widgetWarmupTargetToday: '81830a86-7ee9-4a64-820b-7c8a849ccc56',
  widgetSends7d: '0f881562-fae3-46c3-aa6d-f83b5fcb6b90',
  widgetSendsByDay: '4c810b34-cb7b-4b2e-9223-07b4f008cb46',
  widgetWarmupTargetByDay: 'e4c4148e-78c3-4014-bd0a-703d1bd7c79e',
  widgetCostByDay: 'd56a42be-d72c-471a-8795-1fcc0b354b5e',
  widgetRunsByDay: '6c34288d-155d-4494-9aba-bd69424f39ee',
  widgetLatestRuns: 'ac29e011-d8dd-4a01-a024-2ffe9819786d',
  widgetNotes: 'b78cc343-9693-4c00-888e-487a11ca0f71',
} as const;

// Vista de widget (TABLE_WIDGET) con los últimos Agent runs, sin los [TEST].
export const LATEST_AGENT_RUNS_VIEW_IDS = {
  view: 'af94ddc0-cf98-460d-8479-657daf03703e',
  fieldName: 'a66843dc-6649-4aeb-844c-ae64ab2d9e85',
  fieldOutcome: '4dcb081f-e8a2-4229-9db7-412b6cb5e80a',
  fieldCost: 'fac33d21-4c68-44f9-9a2c-8eadb50d1b93',
  fieldStartedAt: 'eedccfe2-c5a0-44f7-96c5-0a4b84905777',
  fieldCompany: '1e072f70-abee-4806-85f7-68a3d83166e5',
  fieldTraceUrl: '953c6b0b-9f52-46ad-9539-9c4a854358a9',
  sortStartedAt: '84c4d89a-fd21-4280-9567-a178b8c04753',
  filterNotTest: '4950519f-7ac4-46be-bc37-a29646ef85f6',
} as const;

// Ids de los grupos de filtros de cada gráfico (recordFilterGroups), uno por widget. Son
// UUID v4 estables para que el sync no vea cambios en cada build.
export const METRICS_CHART_FILTER_GROUP_IDS = {
  runsToday: '1f61d442-db55-46a2-9ddf-97ffb8e370f9',
  runs7d: '85428c6c-55f5-4364-ba17-67e725a686cf',
  costToday: 'bfc0f69c-3d6a-447a-aeae-90ee939ad69f',
  cost7d: 'b9ac3116-ee67-4667-83cd-c7848d1bcfcf',
  acceptance: 'c648c29b-9fc8-4479-9388-a32209af9136',
  sendsToday: '321312dc-1634-491a-ba09-ed250cd824aa',
  warmupTargetToday: '4c0c7e22-56ca-4702-8f32-a0f3151cbe0a',
  sends7d: '514d8367-e51a-4515-a869-4c8f1546004b',
  sendsByDay: 'f1007be1-348c-48c8-a48d-57faa0e96b7a',
  warmupTargetByDay: 'eb4dc781-040f-4639-9c72-f3e01eea8dff',
  costByDay: '21124b36-c718-4a1c-aaa7-3db9316c69f0',
  runsByDay: '6d741a07-ed7e-4bea-aedf-12e604eb592b',
} as const;

export const HYPOTHESES_BY_STATUS_VIEW_IDS = {
  view: '879418ee-067f-4a89-bc2d-0f7485d039e3',
  fieldName: 'a1082e90-bd29-4766-a54f-4d62140fae18',
  fieldNeed: '6071d026-4f74-4ccf-a60e-aeb54051d79c',
  fieldCompany: '4a7886ac-d875-493f-96a0-7293d49cf0ec',
  fieldStatus: '0dc38b5b-133d-40eb-86c2-c230cf27d699',
  fieldConfidence: '7ac83c30-5ed5-4bcf-9c61-76d2e507d67d',
  fieldBudgetMax: 'a102bb9a-b367-4201-82de-07b269ffe88e',
  fieldTiming: 'e184b06e-585e-4208-bcde-3872a9e3c5d6',
  groupProposed: '6970a381-4606-4cf2-9f07-c76d011ce6b2',
  groupValidated: '56287382-e8d1-4e82-a509-7e78a933695c',
  groupRejected: '06a4856a-9db4-4d3c-95d4-eae4283f3671',
  groupExpired: '5ee2ca58-128f-40da-9c76-e3e86334753e',
} as const;

export const RECENT_SIGNALS_VIEW_IDS = {
  view: 'b026c96d-248a-45d5-95f8-3bd39a31ffdb',
  fieldName: '0b092e61-8529-47d4-a7c8-d7b80404aef5',
  fieldCompany: 'fbdc2d7d-f2d4-4d8d-a070-8438d3c4f628',
  fieldSignalType: 'ad1373eb-5c4e-4f42-8c69-c6f48f5e9dd8',
  fieldStatus: '8db734e3-00e4-49b3-99d5-70cd218a1b8b',
  fieldConfidence: '8be75bb8-7bff-4a13-8a6c-73a0130c023e',
  fieldEventDate: '1b0eb56d-b8bc-4b9d-81e0-3ae8dc6562e7',
  fieldDetectedAt: '9044cbb4-71b5-4be1-8dbe-40e46bd5b83b',
  sortDetectedAt: '584b953a-0e37-4331-9a36-733d5faf9dd1',
} as const;
