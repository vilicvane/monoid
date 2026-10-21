import classNames from 'classNames';
import {
  BookKey as bookKey,
  LayoutGrid as layoutGrid,
  Scan as scan,
} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useLayoutEffect, useRef, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {getPendingActions} from '../../@lib/pending-action.js';
import {navigationTransition} from '../@animations.js';
import {FEATURES} from '../@features.js';

import {Tab as Tab_} from './@tab.js';

export const Container = styled.nav`
  --nav-bar-icon-size: 20px;

  box-sizing: content-box;
  height: var(--nav-bar-height);
  padding: 0 0 var(--view-inset-bottom);

  display: flex;
  /* Half a tab gap plus 0.4 leaves 90% of a gap before the first icon. */
  &::before {
    content: '';
    flex: 0.4 1 var(--ion-safe-area-left, 0px);
  }
`;

const Tab = styled(Tab_)`
  height: var(--nav-bar-height);
  flex: 1 1 var(--nav-bar-icon-size);
  min-width: 0;
  /* Clip ripple overflow vertically without clipping the separate FAB slot. */
  clip-path: inset(
    0 var(--nav-tab-ripple-clip, -20px) calc(-1 * var(--view-inset-bottom))
  );
`;

const HomeGroup = styled.div<{$expanded: boolean}>`
  container-type: inline-size;
  /* Keep each ripple as wide as an outer tab, independent of grouping. */
  --nav-tab-ripple-width: calc(100cqw + 40px);
  --nav-tab-ripple-clip: -100cqw;

  display: flex;
  justify-content: center;
  flex: 1 1 var(--nav-bar-icon-size);
  box-sizing: content-box;
  padding-inline: ${props => (props.$expanded ? 20 : 0)}px;
  min-width: 0;

  transition:
    padding-left ${navigationTransition.duration}ms
      ${navigationTransition.easing},
    padding-right ${navigationTransition.duration}ms
      ${navigationTransition.easing};

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const HomeTab = styled(Tab)`
  flex: 0 0 40px;
`;

const FeatureTab = styled(Tab)<{$visible: boolean}>`
  flex: 0 0 ${props => (props.$visible ? '40px' : '0px')};
  opacity: ${props => (props.$visible ? 1 : 0)};
  transform: scale(${props => (props.$visible ? 1 : 0)});

  transition:
    color 0.2s linear,
    flex-basis ${navigationTransition.duration}ms ${navigationTransition.easing},
    opacity ${navigationTransition.duration}ms ${navigationTransition.easing},
    transform ${navigationTransition.duration}ms ${navigationTransition.easing};

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const FabSlot = styled.div<{$active: boolean}>`
  position: relative;
  /* Match the 90% leading gap; reserve 10% less before the FAB. */
  flex: ${props => (props.$active ? 0.3 : 0.4)} 1
    calc(
      ${props => (props.$active ? '66px' : '0px')} +
        var(--ion-safe-area-right, 0px)
    );
  min-width: 0;
  height: var(--nav-bar-height);

  transition:
    flex-grow ${navigationTransition.duration}ms ${navigationTransition.easing},
    flex-basis ${navigationTransition.duration}ms ${navigationTransition.easing};

  > div {
    position: absolute;
    inset: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

export const Tabs = observer(({className}: {className?: string}): ReactNode => {
  const {router, walletKitService, portals} = useEntrances();
  const fabSlotRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    fabSlotRef.current!.append(portals.fab);

    return () => portals.fab.remove();
  }, [portals.fab]);

  const pendingCount = getPendingActions(walletKitService).length;
  const routes = [
    router.features,
    ...FEATURES.map(({route}) => router[route]),
    router.scan,
    router.safe,
  ];
  const activity = routes.some(route => route.$transition)
    ? '$transition'
    : '$active';
  const feature = FEATURES.find(({route}) => router[route][activity]);
  const activeRoute = routes.find(route => route[activity]);
  const [navigation, setNavigation] = useState({
    activeRoute,
    feature,
    lastFeature: feature ?? FEATURES[0],
  });

  if (
    navigation.activeRoute !== activeRoute ||
    navigation.feature !== feature
  ) {
    setNavigation({
      activeRoute,
      feature,
      lastFeature: feature ?? navigation.lastFeature,
    });
  }

  const displayedFeature = feature ?? navigation.lastFeature;

  return (
    <Container aria-label="Main navigation" className={classNames(className)}>
      <HomeGroup $expanded={!!feature}>
        <HomeTab
          label="Home"
          icon={layoutGrid}
          badge={pendingCount}
          route={router.features}
          activity={activity}
        />
        <FeatureTab
          $visible={!!feature}
          inert={!feature}
          label={displayedFeature.name}
          icon={displayedFeature.icon}
          route={router[displayedFeature.route]}
          activity={activity}
        />
      </HomeGroup>
      <Tab label="Scan" icon={scan} route={router.scan} activity={activity} />
      <Tab
        label="Safe"
        icon={bookKey}
        route={router.safe}
        activity={activity}
      />
      <FabSlot ref={fabSlotRef} $active={portals.fabActive} />
    </Container>
  );
});
