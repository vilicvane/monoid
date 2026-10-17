import classNames from 'classNames';
import type {HTMLAttributes, ReactNode} from 'react';
import {styled} from 'styled-components';

import {Address as Address_} from './address.js';
import {CopyButton} from './copy-button.js';
import {inlineIconRowCSS} from './inline-icon.js';

const Container = styled.div`
  ${inlineIconRowCSS}
`;

const Address = styled(Address_)`
  flex: 1;
  min-width: 0;

  &.clickable {
    text-decoration: underline;
  }
`;

export const InteractiveAddress = ({
  clickable = false,
  copyable = false,
  children: address,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  clickable?: boolean;
  copyable?: boolean;
  children: string;
}): ReactNode => {
  return (
    <Container {...props}>
      <Address
        className={classNames({
          clickable,
        })}
        onClick={
          clickable
            ? () => open(`https://etherscan.io/address/${address}`)
            : undefined
        }
      >
        {address}
      </Address>
      {copyable && <CopyButton value={address} label="Copy address" />}
    </Container>
  );
};
