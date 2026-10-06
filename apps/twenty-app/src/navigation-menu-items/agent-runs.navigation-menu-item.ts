import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import { NAVIGATION_MENU_ITEM_IDS } from 'src/constants/layout-universal-identifiers';
import { AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_MENU_ITEM_IDS.agentRuns,
  name: 'Agent runs',
  icon: 'IconRobot',
  color: 'gray',
  position: 3,
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER,
  folderUniversalIdentifier: NAVIGATION_MENU_ITEM_IDS.commercialOsFolder,
});
