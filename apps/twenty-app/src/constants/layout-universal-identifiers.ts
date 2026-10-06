// Identificadores universales estables de navegación y vistas.

export const NAVIGATION_MENU_ITEM_IDS = {
  commercialOsFolder: 'f15b2314-7d6f-4c44-8fa7-b9070a6b06e1',
  signals: '8059bbb7-a3b1-49a1-9440-6a5f6a2d2a07',
  research: '84a47967-2b4c-4153-a861-aa628b648729',
  hypotheses: '3d63d987-89ae-44e7-a866-559678465ec0',
  agentRuns: '766b174f-2f94-4aa5-bda9-4d2b7987e4d5',
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
