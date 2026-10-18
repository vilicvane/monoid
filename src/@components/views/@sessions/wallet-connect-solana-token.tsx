import type {ReactNode} from 'react';

import type {SolanaTokenInstruction} from '../../../@lib/solana-token-instruction.js';
import type {SolanaTokenReview} from '../../../@lib/solana-token-review.js';
import type {WalletKeyData} from '../../../@services/index.js';
import {WalletAddressFieldset} from '../../@key/wallet-address-fieldset.js';
import {ExpandableAddress} from '../../@ui/expandable-address.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoSectionItemLabel,
} from '../../@ui/info-section.js';
import {SolanaTokenAmount} from '../../@ui/solana-token.js';

export function WalletConnectSolanaToken({
  decoded,
  token,
  chainId,
  keys,
}: {
  decoded: SolanaTokenInstruction;
  token?: SolanaTokenReview;
  chainId: string;
  keys: readonly WalletKeyData[];
}): ReactNode {
  return (
    <>
      <InfoFieldset>
        <InfoLegend>
          {decoded.kind === 'token-transfer' ? 'From account' : 'Token account'}
        </InfoLegend>
        <ExpandableAddress>
          {decoded.kind === 'token-account-create'
            ? decoded.account
            : decoded.source}
        </ExpandableAddress>
      </InfoFieldset>
      {decoded.kind === 'token-transfer' && (
        <InfoFieldset>
          <InfoLegend>To account</InfoLegend>
          <ExpandableAddress>{decoded.destination}</ExpandableAddress>
        </InfoFieldset>
      )}
      {decoded.kind === 'token-approve' && (
        <WalletAddressFieldset
          keys={keys}
          addressType="solana"
          address={decoded.delegate}
          label="Delegate"
        />
      )}
      <WalletAddressFieldset
        keys={keys}
        addressType="solana"
        address={
          decoded.kind === 'token-account-create'
            ? decoded.owner
            : decoded.authority
        }
        label={decoded.kind === 'token-account-create' ? 'Owner' : 'Authority'}
      />
      {decoded.kind === 'token-account-create' ? (
        <WalletAddressFieldset
          keys={keys}
          addressType="solana"
          address={decoded.payer}
          label="Payer"
        />
      ) : 'amount' in decoded ? (
        <InfoFieldset $equalPadding>
          <InfoLegend>
            {decoded.kind === 'token-approve' ? 'Allowance' : 'Amount'}
          </InfoLegend>
          <InfoFieldsetValue>
            <SolanaTokenAmount
              chainId={chainId}
              token={token}
              value={decoded.amount}
            />
          </InfoFieldsetValue>
        </InfoFieldset>
      ) : (
        <InfoSectionItemLabel>
          Clears this token account’s delegate.
        </InfoSectionItemLabel>
      )}
      {'additionalSigners' in decoded && decoded.additionalSigners && (
        <InfoFieldset>
          <InfoLegend>Additional signers</InfoLegend>
          {decoded.additionalSigners.map(address => (
            <ExpandableAddress key={address}>{address}</ExpandableAddress>
          ))}
        </InfoFieldset>
      )}
    </>
  );
}
