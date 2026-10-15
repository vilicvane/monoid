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
  flex-shrink: 0;
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

const Identity = styled.div`
  min-width: 0;
`;

const Domain = styled.p`
  display: flex;
  align-items: center;
  gap: 6px;

  span {
    min-width: 0;
  }
`;

const VerificationIcon = styled(IonIcon)<{
  $valid: boolean;
  $dangerous: boolean;
}>`
  flex-shrink: 0;
  font-size: 18px;
  color: ${props =>
    props.$dangerous
      ? 'var(--ion-color-danger)'
      : props.$valid
        ? 'var(--ion-color-primary)'
        : 'var(--color-text-secondary)'};
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

type SiteInfo = {
  name: string;
  url: URL | undefined;
  valid: boolean;
  dangerous: boolean;
  message: string;
};

type SiteProps = {
  metadata: WalletKitTypes.Metadata;
  verified: WalletKitTypes.SessionProposal['verifyContext']['verified'];
};

export function getWalletConnectSiteInfo({
  metadata,
  verified,
}: SiteProps): SiteInfo {
  const url = parseHttpUrl(metadata.url);
  const name = metadata.name.trim() || url?.hostname || 'Unknown site';
  const dangerous = !!verified.isScam || verified.validation === 'INVALID';
  const valid = !!url && !dangerous && verified.validation === 'VALID';
  const message = verified.isScam
    ? 'Reported as unsafe'
    : verified.validation === 'INVALID'
      ? 'Domain does not match'
      : valid
        ? 'Domain verified'
        : 'Domain not verified';

  return {url, name, valid, dangerous, message};
}

export function WalletConnectVerificationIcon({
  info,
}: {
  info: SiteInfo;
}): ReactNode {
  return (
    <VerificationIcon
      $valid={info.valid}
      $dangerous={info.dangerous}
      icon={
        info.dangerous ? shieldAlert : info.valid ? badgeCheck : shieldQuestion
      }
      title={`${info.message}: ${info.url?.hostname ?? 'Invalid site address'}`}
      aria-label={info.message}
    />
  );
}

export function WalletConnectSite(props: SiteProps): ReactNode {
  const info = getWalletConnectSiteInfo(props);
  const {url, name, valid, dangerous, message} = info;
  const {metadata} = props;

  return (
    <Container aria-label="Site">
      <SiteLogo name={name} url={metadata.url} icons={metadata.icons} />
      <Identity>
        <h2 title={name}>{name}</h2>
        <Domain>
          <span title={url?.hostname}>
            {url?.hostname ?? 'Invalid site address'}
          </span>
          {valid && <WalletConnectVerificationIcon info={info} />}
        </Domain>
        {!valid && (
          <Verification $dangerous={dangerous}>
            <WalletConnectVerificationIcon info={info} />
            {message}
          </Verification>
        )}
      </Identity>
    </Container>
  );
}
