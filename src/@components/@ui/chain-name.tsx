import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

import {InfoSectionHeader} from './info-section.js';

const Content = styled(InfoSectionHeader)`
  min-width: 0;
  font-size: 14px;
  overflow-wrap: anywhere;
`;

const Name = styled.span`
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;

  > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const Icon = styled.img`
  display: block;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: contain;
`;

const Identifier = styled.span`
  flex-shrink: 0;
  max-width: 100%;
  margin-left: auto;
  color: var(--ion-color-medium);
  font-size: 12px;
  text-align: right;
`;

export const ChainName = observer(({chainId}: {chainId: string}): ReactNode => {
  const {chainService} = useEntrances();
  const name = chainService.getChainName(chainId);
  const icon = chainService.getChainIcon(chainId);
  const [failedIcon, setFailedIcon] = useState<string>();

  useEffect(() => {
    void chainService.refresh().catch(console.warn);
  }, [chainService]);

  return (
    <Content title={name ? `${name} (${chainId})` : chainId}>
      {name && (
        <Name>
          {icon && icon !== failedIcon && (
            <Icon
              src={icon}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setFailedIcon(icon)}
            />
          )}
          <span>{name}</span>
        </Name>
      )}
      <Identifier>{chainId}</Identifier>
    </Content>
  );
});
