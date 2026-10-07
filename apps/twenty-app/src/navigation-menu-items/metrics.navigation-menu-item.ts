import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  METRICS_PAGE_IDS,
  NAVIGATION_MENU_ITEM_IDS,
} from 'src/constants/layout-universal-identifiers';

// Abre la página nativa «Agent OS · Métricas» (STANDALONE_PAGE).
export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_MENU_ITEM_IDS.metrics,
  name: 'Métricas',
  icon: 'IconChartBar',
  color: 'gray',
  position: 4,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  pageLayoutUniversalIdentifier: METRICS_PAGE_IDS.pageLayout,
  folderUniversalIdentifier: NAVIGATION_MENU_ITEM_IDS.commercialOsFolder,
});
