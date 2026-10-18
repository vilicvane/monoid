import {networks} from '@web3icons/common/metadata/networks';
import {Info as info} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

import {AppIcon} from './app-icon.js';

// Include only network icons in the requested background variant.
const icons = import.meta.glob<string>(
  '/node_modules/@web3icons/core/dist/svgs/networks/background/*.svg.js',
  {eager: true, import: 'default'},
);

const iconsByChainId = new Map(
  networks.flatMap(({caip2id, filePath}) => {
    const [type, name] = filePath.split(':');
    if (!caip2id || type !== 'network') return [];

    const svg =
      icons[
        `/node_modules/@web3icons/core/dist/svgs/networks/background/${name}.svg.js`
      ];
    return svg
      ? [[caip2id, `data:image/svg+xml,${encodeURIComponent(svg)}`] as const]
      : [];
  }),
);

const Icon = styled.img`
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
`;

export const ChainIcon = observer(
  ({chainId, className}: {chainId: string; className?: string}): ReactNode => {
    const {chainService} = useEntrances();
    const icon =
      iconsByChainId.get(chainId) ??
      (chainId.startsWith('solana:')
        ? iconsByChainId.get('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
        : undefined) ??
      chainService.getChainIcon(chainId);
    const [failedIcon, setFailedIcon] = useState<string>();

    return icon && icon !== failedIcon ? (
      <Icon
        className={className}
        src={icon}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailedIcon(icon)}
      />
    ) : (
      <Icon as={AppIcon} className={className} icon={info} aria-hidden="true" />
    );
  },
);
