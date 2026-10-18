import classNames from 'classNames';
import {
  BookKey as bookKey,
  LayoutGrid as layoutGrid,
  Scan as scan,
} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
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
  clip-path: inset(0 -20px calc(-1 * var(--view-inset-bottom)));
`;

const FeatureTab = styled(Tab)<{$visible: boolean}>`
  flex-grow: ${props => (props.$visible ? 1 : 0)};
  flex-basis: ${props => (props.$visible ? 'var(--nav-bar-icon-size)' : '0px')};
  overflow: hidden;
  opacity: ${props => (props.$visible ? 1 : 0)};
  transform: scale(${props => (props.$visible ? 1 : 0)});

  transition:
    color 0.2s linear,
    flex-grow ${navigationTransition.duration}ms ${navigationTransition.easing}
      ${props => (props.$visible ? 0 : navigationTransition.duration)}ms,
    flex-basis ${navigationTransition.duration}ms ${navigationTransition.easing}
      ${props => (props.$visible ? 0 : navigationTransition.duration)}ms,
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
    dotDelay: navigationTransition.duration,
  });

  // Set the delay before the newly active dot starts its transition.
  if (
    navigation.activeRoute !== activeRoute ||
    navigation.feature !== feature
  ) {
    setNavigation({
      activeRoute,
      feature,
      lastFeature: feature ?? navigation.lastFeature,
      dotDelay:
        navigationTransition.duration *
        (navigation.feature && !feature ? 2 : 1),
    });
  }

  const displayedFeature = feature ?? navigation.lastFeature;

  return (
    <Container
      aria-label="Main navigation"
      className={classNames(className)}
      style={{'--nav-dot-delay': `${navigation.dotDelay}ms`} as CSSProperties}
    >
      <Tab
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
