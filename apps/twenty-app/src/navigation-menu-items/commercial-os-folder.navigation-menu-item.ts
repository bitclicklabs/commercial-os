import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import { NAVIGATION_MENU_ITEM_IDS } from 'src/constants/layout-universal-identifiers';

// LLD §23 — carpeta "Commercial OS" en la barra lateral.
export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_MENU_ITEM_IDS.commercialOsFolder,
  name: 'Commercial OS',
  icon: 'IconBriefcase',
  color: 'blue',
  position: 0,
  type: NavigationMenuItemType.FOLDER,
});
