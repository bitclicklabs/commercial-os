import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import { NAVIGATION_MENU_ITEM_IDS } from 'src/constants/layout-universal-identifiers';
import { COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_MENU_ITEM_IDS.hypotheses,
  name: 'Hypotheses',
  icon: 'IconBulb',
  color: 'amber',
  position: 2,
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
  folderUniversalIdentifier: NAVIGATION_MENU_ITEM_IDS.commercialOsFolder,
});
