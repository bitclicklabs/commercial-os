import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import { NAVIGATION_MENU_ITEM_IDS } from 'src/constants/layout-universal-identifiers';

// Enlace al dashboard técnico del runtime (tabla por agente y versión, latencias, trazas).
// Solo responde a peticiones locales: funciona desde el equipo donde corre el runtime.
export const RUNTIME_DASHBOARD_URL = 'http://127.0.0.1:4020/dashboard';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_MENU_ITEM_IDS.runtimeDashboard,
  name: 'Agent OS (detalle técnico)',
  icon: 'IconExternalLink',
  color: 'gray',
  position: 5,
  type: NavigationMenuItemType.LINK,
  link: RUNTIME_DASHBOARD_URL,
  folderUniversalIdentifier: NAVIGATION_MENU_ITEM_IDS.commercialOsFolder,
});
