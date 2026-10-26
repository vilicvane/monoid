import {
  ArrowUp as arrowUp,
  Check as check,
  CreditCard as creditCard,
  CreditCardX as creditCardX,
  TriangleAlert as triangleAlert,
} from 'lucide-react';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {CardInformation} from '../../../@lib/global-platform/card-information.js';
import {APPLET_NAMES, type AppletStage} from '../../../@lib/monoid/index.js';
import {
  CardGrid,
  CardPlaceholder,
  CardPreview,
  CardPreviewButton,
} from '../../@monoid/card-preview.js';
import {AppIcon} from '../../@ui/app-icon.js';
import {AppletIcon} from '../../@ui/feature-icons.js';
import {InfoSection} from '../../@ui/info-section.js';
import {
  IconList,
  LIST_ICON_SIZE,
  ListItem,
  ListItemButton,
  ListItemContent,
  ListItemDescription,
  ListItemName,
} from '../../@ui/list.js';
import {InfoMessage} from '../../@ui/message-content.js';
import {CardSetupInformation} from '../safe/index.js';

const Empty = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding-bottom: 60px;
`;

const EmptyCard = styled.div`
  position: relative;
  width: 224px;
  max-width: 100%;
`;

const Placeholder = styled(CardPlaceholder)<{$unsupported: boolean}>`
  font-size: 36px;
  --icon-stroke-width: 1;

  ${props =>
    props.$unsupported &&
    `
      --monoid-card-background: rgba(var(--ion-color-danger-rgb), 0.05);
      border-color: rgba(var(--ion-color-danger-rgb), 0.2);
      color: rgba(var(--ion-color-danger-rgb), 0.5);
    `}
`;

const Caption = styled.p`
  position: absolute;
  top: calc(100% + 16px);
  left: 0;
  width: 100%;
  margin: 0;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 14px;
`;

/** Both empty states share their geometry, including the caption's footprint. */
export function CardScanPlaceholder({
  unsupported = false,
}: {
  unsupported?: boolean;
}): ReactNode {
  return (
    <Empty>
      <EmptyCard>
        <Placeholder $unsupported={unsupported}>
          <AppIcon icon={unsupported ? creditCardX : creditCard} />
        </Placeholder>
        {unsupported && <Caption>Card not supported</Caption>}
      </EmptyCard>
    </Empty>
  );
}

const Compatibility = styled(InfoSection)`
  margin-top: 25px;
  font-size: 14px;
`;

export function CardInformationContent({
  information,
}: {
  information: CardInformation;
}): ReactNode {
  return (
    <Compatibility>
      <CardSetupInformation information={information} />
    </Compatibility>
  );
}

const Hero = styled.div`
  width: 224px;
  max-width: 100%;
  margin: 12px auto 30px;
`;

const Applets = styled(IconList)`
  flex: none;
  margin-top: 4px;
`;

const AppletRow = styled(ListItem)`
  align-items: center;
`;

const Symbol = styled.span`
  width: ${LIST_ICON_SIZE}px;
  height: ${LIST_ICON_SIZE}px;
  border-radius: ${LIST_ICON_SIZE / 4}px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 28px;
`;

const Status = styled(AppIcon)<{$status: 'unknown' | 'update' | 'installed'}>`
  flex-shrink: 0;
  font-size: 18px;
  color: ${props =>
    props.$status === 'unknown'
      ? 'var(--color-text-warning)'
      : props.$status === 'update'
        ? 'var(--ion-color-primary)'
        : 'var(--ion-color-safe)'};
`;

export type AppletDisplay = {
  name: AppletStage;
  installed: boolean;
  version?: string;
  unknown?: boolean;
  update?: boolean;
  selectable?: boolean;
};

export function CardMaintenanceCards({
  cards,
  onSelect,
  disabled = false,
}: {
  cards: readonly {
    publicKey: string;
    id?: string;
    complete: boolean;
    pending?: boolean;
    status: string;
    interrupted?: boolean;
  }[];
  onSelect?: (publicKey: string) => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <CardGrid>
      {cards.map(card => (
        <CardPreviewButton
          key={card.publicKey}
          disabled={disabled || !onSelect || card.complete || !card.id}
          onClick={() => onSelect?.(card.publicKey)}
          aria-label={`Card ${card.id ?? 'unknown'}`}
        >
          <CardPreview
            id={card.id}
            description={card.status}
            $pending={card.pending ?? !card.complete}
            $interrupted={card.interrupted}
          />
        </CardPreviewButton>
      ))}
    </CardGrid>
  );
}

export function CardAppletsContent({
  id,
  bundled,
  recovery,
  manualRestore,
  applets,
  onSelectApplet,
}: {
  id?: string;
  bundled?: boolean;
  recovery?: boolean;
  manualRestore?: boolean;
  applets: AppletDisplay[];
  onSelectApplet?: (stage: AppletStage) => void;
}): ReactNode {
  return (
    <>
      <Hero>
        <CardPreview
          id={id}
          description={bundled ? 'bundle' : undefined}
          $interrupted={recovery}
        />
      </Hero>
      <Applets>
        {applets.map(applet => {
          const status = applet.unknown
            ? 'unknown'
            : applet.update
              ? 'update'
              : 'installed';
          const content = (
            <>
              <Symbol>
                <AppIcon icon={AppletIcon} aria-hidden="true" />
              </Symbol>
              <ListItemContent>
                <ListItemName>{APPLET_NAMES[applet.name]}</ListItemName>
                <ListItemDescription>
                  {applet.unknown
                    ? 'Unknown'
                    : !applet.installed
                      ? 'Not installed'
                      : (applet.version ?? 'Installed')}
                </ListItemDescription>
              </ListItemContent>
              {(applet.unknown || applet.installed) && (
                <Status
                  icon={
                    status === 'unknown'
                      ? triangleAlert
                      : status === 'update'
                        ? arrowUp
                        : check
                  }
                  $status={status}
                  aria-label={
                    status === 'unknown'
                      ? 'Version unknown'
                      : status === 'update'
                        ? 'Update available'
                        : 'Installed'
                  }
                />
              )}
            </>
          );
          return applet.selectable ? (
            <ListItemButton
              key={applet.name}
              type="button"
              onClick={() => onSelectApplet?.(applet.name)}
            >
              {content}
            </ListItemButton>
          ) : (
            <AppletRow key={applet.name}>{content}</AppletRow>
          );
        })}
      </Applets>
      {manualRestore && (
        <InfoMessage>Restore your items from another bundle card.</InfoMessage>
      )}
    </>
  );
}
