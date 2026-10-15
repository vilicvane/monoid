import {IonIcon} from '@ionic/react';
import type {WalletKitTypes} from '@reown/walletkit';
import badgeCheck from 'lucide-static/icons/badge-check.svg';
import shieldAlert from 'lucide-static/icons/shield-alert.svg';
import shieldQuestion from 'lucide-static/icons/shield-question.svg';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {parseHttpUrl} from '../../../@lib/site-logo.js';
import {SiteLogo} from '../../@ui/site-logo.js';

const Container = styled.section`
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  align-items: center;
  gap: 8px 16px;
  margin: 8px 0 24px;
  overflow-wrap: anywhere;

  h2 {
    margin: 0 0 4px;
    font-size: 20px;
  }

  p {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: 14px;
    line-height: 1.5;
  }
`;

const Domain = styled.p`
  ion-icon {
    margin-left: 6px;
    color: var(--ion-color-primary);
    font-size: 18px;
    vertical-align: middle;
  }
`;

const Verification = styled.p<{$dangerous: boolean}>`
  display: flex;
  align-items: center;
  gap: 6px;

  && {
    margin-top: 4px;
    color: ${props =>
      props.$dangerous
        ? 'var(--ion-color-danger)'
        : 'var(--color-text-secondary)'};
  }

  ion-icon {
    flex-shrink: 0;
    font-size: 18px;
  }
`;

export function WalletConnectSite({
  proposal,
}: {
  proposal: WalletKitTypes.SessionProposal;
}): ReactNode {
  const {metadata} = proposal.params.proposer;
  const url = parseHttpUrl(metadata.url);
  const name = metadata.name.trim() || url?.hostname || 'Unknown site';
  const {verified} = proposal.verifyContext;
  const dangerous = !!verified.isScam || verified.validation === 'INVALID';
  const valid = !!url && !dangerous && verified.validation === 'VALID';
  const message = verified.isScam
    ? 'Reported as unsafe'
    : verified.validation === 'INVALID'
      ? 'Domain does not match'
      : 'Domain not verified';

  return (
    <Container aria-label="Requesting site">
      <SiteLogo name={name} url={metadata.url} icons={metadata.icons} />
      <div>
        <h2>{name}</h2>
        <Domain>
          {url?.hostname ?? 'Invalid site address'}
          {valid && (
            <IonIcon
              icon={badgeCheck}
              title="Domain verified"
              aria-label="Domain verified"
            />
          )}
        </Domain>
        {!valid && (
          <Verification $dangerous={dangerous}>
            <IonIcon
              icon={dangerous ? shieldAlert : shieldQuestion}
              aria-hidden="true"
            />
            {message}
          </Verification>
        )}
      </div>
    </Container>
  );
}
