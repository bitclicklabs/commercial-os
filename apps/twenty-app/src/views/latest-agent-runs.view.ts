import {
  defineView,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import { AGENT_RUN_SUMMARY_FIELD_IDS as F } from 'src/constants/field-universal-identifiers';
import { LATEST_AGENT_RUNS_VIEW_IDS as IDS } from 'src/constants/layout-universal-identifiers';
import { AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

// Vista de widget (TABLE_WIDGET): la usa la tabla «Últimos runs» de la página de métricas.
// Las vistas *_WIDGET no salen en el selector de vistas del objeto ni en la barra lateral.
// Oculta los runs de los tests de integración (tarea con prefijo "[TEST]").
export default defineView({
  universalIdentifier: IDS.view,
  name: 'Latest agent runs (metrics widget)',
  objectUniversalIdentifier: AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER,
  type: ViewType.TABLE_WIDGET,
  icon: 'IconRobot',
  position: 1,
  fields: [
    { universalIdentifier: IDS.fieldName, fieldMetadataUniversalIdentifier: F.name, position: 0, isVisible: true, size: 320 },
    { universalIdentifier: IDS.fieldOutcome, fieldMetadataUniversalIdentifier: F.outcome, position: 1, isVisible: true, size: 110 },
    { universalIdentifier: IDS.fieldCost, fieldMetadataUniversalIdentifier: F.cost, position: 2, isVisible: true, size: 100 },
    { universalIdentifier: IDS.fieldStartedAt, fieldMetadataUniversalIdentifier: F.startedAt, position: 3, isVisible: true, size: 150 },
    { universalIdentifier: IDS.fieldCompany, fieldMetadataUniversalIdentifier: F.company, position: 4, isVisible: true, size: 160 },
    { universalIdentifier: IDS.fieldTraceUrl, fieldMetadataUniversalIdentifier: F.traceUrl, position: 5, isVisible: true, size: 160 },
  ],
  filters: [
    {
      universalIdentifier: IDS.filterNotTest,
      fieldMetadataUniversalIdentifier: F.task,
      operand: ViewFilterOperand.DOES_NOT_CONTAIN,
      value: '[TEST]',
    },
  ],
  sorts: [
    {
      universalIdentifier: IDS.sortStartedAt,
      fieldMetadataUniversalIdentifier: F.startedAt,
      direction: ViewSortDirection.DESC,
    },
  ],
});
