import {IonFabButton} from '@ionic/react';
import {
  ArrowRight as arrowRight,
  Star as star,
  StarOff as starOff,
} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import type {FeatureRoute} from '../../@features.js';
import {hasBitcoinWallet} from '../../@lib/bitcoin-wallet.js';
import {
  type PendingAction,
  getPendingActions,
} from '../../@lib/pending-action.js';
import type {Router} from '../../@routes.js';
import {FEATURES} from '../@features.js';
import {AppIcon} from '../@ui/app-icon.js';
import {InfoSection} from '../@ui/info-section.js';
import {
  List,
  ListItemButton,
  ListItemContent,
  ListItemDescription,
  ListItemName,
} from '../@ui/list.js';
import {RippleEffect} from '../@ui/ripple-effect.js';
import {
  SwipeAction,
  SwipeActionIcon,
  SwipeableItem,
} from '../@ui/swipeable-item.js';
import {
  View,
  ViewContent,
  ViewFab,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

import {PendingActions} from './@home/pending-actions.js';

const FeatureList = styled(List)`
  --list-item-gap: 14px;
  --list-item-content-gap: 5px;
`;

const FeatureIcon = styled(AppIcon)<{$color: string}>`
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  padding: 12px;
  border-radius: 14px;
  background: ${({$color}) => $color};
  color: var(--ion-color-primary-contrast);
`;

const DefaultIcon = styled(AppIcon)`
  --icon-stroke-width: 1;

  flex-shrink: 0;
  padding: 3px;
  border-radius: 50%;
  background-color: var(--color-derivations-badge);
  font-size: 12px;
  color: var(--color-derivations-badge-contrast);
`;

export const FeaturesView = observer(
  ({view, transition}: RouteComponentProps<Router['features']>): ReactNode => {
    const {
      router,
      appPreferencesService,
      errorService,
      walletKitService,
      walletStorageService,
    } = useEntrances();
    const [openFeature, setOpenFeature] = useState<FeatureRoute>();
    const [saving, setSaving] = useState(false);
    const active = !view.$leaving && view.$match.$exact.$active;
    const actions = getPendingActions(walletKitService);
    const nextAction = actions[0];
    const features = FEATURES.filter(
      ({route}) =>
        route !== 'bitcoin' || hasBitcoinWallet(walletStorageService.keys),
    );

    const openAction = (action: PendingAction): void => {
      router.sessions.request({id: action.request.id}).$push();
    };

    const setDefaultFeature = errorService.catch(
      async (route: FeatureRoute) => {
        setSaving(true);
        try {
          await appPreferencesService.setDefaultFeature(
            appPreferencesService.defaultFeature === route ? undefined : route,
          );
          setOpenFeature(current => (current === route ? undefined : current));
        } finally {
          setSaving(false);
        }
      },
    );

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Home</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          <InfoSection as="section" aria-label="Features">
            <FeatureList>
              {features.map(({route, name, description, icon, color}) => {
                const isDefault =
                  appPreferencesService.defaultFeature === route;

                return (
                  <SwipeableItem
                    key={route}
                    open={openFeature === route}
                    onOpenChange={open =>
                      setOpenFeature(current =>
                        open ? route : current === route ? undefined : current,
                      )
                    }
                    actions={
                      <SwipeAction
                        type="button"
                        $color="var(--color-derivations-badge)"
                        disabled={saving}
                        aria-busy={saving && openFeature === route}
                        onClick={() => setDefaultFeature(route)}
                      >
                        <SwipeActionIcon>
                          <AppIcon
                            icon={isDefault ? starOff : star}
                            aria-hidden="true"
                          />
                        </SwipeActionIcon>
                        {isDefault ? 'Clear' : 'Default'}
                      </SwipeAction>
                    }
                  >
                    <ListItemButton
                      type="button"
                      className="ion-activatable"
                      data-swipeable-content
                      disabled={saving}
                      onClick={() => {
                        if (openFeature) {
                          setOpenFeature(undefined);
                        } else {
                          router[route].$push();
                        }
                      }}
                    >
                      <FeatureIcon
                        icon={icon}
                        $color={color}
                        aria-hidden="true"
                      />
                      <ListItemContent as="span">
                        <ListItemName>
                          {name}
                          {isDefault && (
                            <DefaultIcon
                              icon={star}
                              role="img"
                              aria-label="Default feature"
                              title="Default feature"
                            />
                          )}
                        </ListItemName>
                        <ListItemDescription>{description}</ListItemDescription>
                      </ListItemContent>
                      <RippleEffect />
                    </ListItemButton>
                  </SwipeableItem>
                );
              })}
            </FeatureList>
          </InfoSection>
          <PendingActions actions={actions} onSelect={openAction} />
        </ViewContent>
        {nextAction && (
          <ViewFab view={view} transition={transition} inert={!active}>
            <IonFabButton
              aria-label="View next"
              onClick={() => openAction(nextAction)}
            >
              <AppIcon icon={arrowRight} />
            </IonFabButton>
          </ViewFab>
        )}
      </View>
    );
  },
);
