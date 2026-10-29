import {type ReactNode, type Ref, useState} from 'react';
import {styled} from 'styled-components';

import monoidCardWirelessInterface from '../../@assets/monoid-card-wireless-interface.svg';
import monoidLogo from '../../@assets/monoid.svg';

export const MonoidCardFrame = styled.div`
  position: relative;
  aspect-ratio: 430 / 270;
  border-radius: calc(20 / 430 * 100%) / calc(20 / 270 * 100%);
  background-color: var(
    --monoid-card-background,
    var(--ion-color-dark-contrast)
  );
`;

const CardWirelessInterface = styled.img`
  position: absolute;
  top: calc(43 / 270 * 100%);
  left: calc(40 / 430 * 100%);
  width: calc(32 / 430 * 100%);
`;

const CardLogo = styled.img<{$error: boolean}>`
  position: absolute;
  top: calc(170 / 270 * 100%);
  right: var(--monoid-card-logo-right, 0);
  width: var(--monoid-card-logo-width, calc(60 / 430 * 100%));
  background-color: ${props =>
    props.$error
      ? 'var(--ion-color-danger)'
      : 'var(--monoid-card-logo-background, var(--ion-color-primary))'};
  transition: background-color 160ms ease-out;
`;

const CardLabel = styled.span`
  position: absolute;
  top: calc(43 / 270 * 100%);
  left: calc(40 / 430 * 100%);
  right: calc(40 / 430 * 100%);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  color: var(--ion-color-medium);
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  letter-spacing: 0.06em;
  white-space: nowrap;
  pointer-events: none;
`;

/** The alias replaces the ID; it reads as text, not as a hex identifier. */
const CardName = styled.span<{$alias: boolean}>`
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  ${props => props.$alias && 'letter-spacing: normal;'}
`;

const CardNameToggle = styled.button<{$alias: boolean}>`
  max-width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: auto;
  cursor: pointer;
  ${props => props.$alias && 'letter-spacing: normal;'}
`;

const CardDescription = styled.span`
  color: var(--monoid-card-description-color, var(--ion-color-primary));
  letter-spacing: normal;
`;

const CardSubtitle = styled.span`
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--monoid-card-description-color, var(--ion-color-primary));
`;

export function MonoidCard({
  className,
  children,
  error = false,
  id,
  alias,
  aliasToggle = false,
  subtitle,
  description,
  ref,
}: {
  className?: string;
  children?: ReactNode;
  error?: boolean;
  id?: string;
  alias?: string | false;
  /** Where the card has no tap action of its own, tapping its name shows the ID. */
  aliasToggle?: boolean;
  subtitle?: string;
  description?: string;
  ref?: Ref<HTMLDivElement>;
}): ReactNode {
  const [showId, setShowId] = useState(false);
  const showAlias = !!alias && !showId;
  const name = showAlias ? alias : id;
  return (
    <MonoidCardFrame className={className} ref={ref}>
      {children}
      {id ? (
        <CardLabel>
          {aliasToggle && alias ? (
            <CardNameToggle
              type="button"
              $alias={showAlias}
              aria-label={
                showAlias ? `Show card ID of ${alias}` : `Show alias of ${id}`
              }
              onClick={event => {
                event.stopPropagation();
                setShowId(value => !value);
              }}
            >
              {name}
            </CardNameToggle>
          ) : (
            <CardName $alias={showAlias}>{name}</CardName>
          )}
          {subtitle && <CardSubtitle>{subtitle}</CardSubtitle>}
          {description && <CardDescription>{description}</CardDescription>}
        </CardLabel>
      ) : (
        <CardWirelessInterface src={monoidCardWirelessInterface} alt="" />
      )}
      <CardLogo src={monoidLogo} alt="" $error={error} />
    </MonoidCardFrame>
  );
}
