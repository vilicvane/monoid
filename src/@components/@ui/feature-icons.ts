import {type IconNode, createLucideIcon} from 'lucide-react';

export const WalletConnectIcon = createLucideIcon('WalletConnect', [
  ['path', {d: 'M4 8a11.3 11.3 0 0 1 16 0', key: 'signal'}],
  ['path', {d: 'm2 12 5 5 5-5 5 5 5-5', key: 'connection'}],
]);

export const EthereumIcon = createLucideIcon('Ethereum', [
  ['path', {d: 'm12 2 7 10-7 4-7-4Z', key: 'diamond'}],
  ['path', {d: 'M12 2v14M5 12l7-3 7 3', key: 'facets'}],
  ['path', {d: 'm6.3 16 5.7 6 5.7-6', key: 'base'}],
]);

export const SolanaIcon = createLucideIcon('Solana', [
  ['path', {d: 'm6 4-3 3h15l3-3Z', key: 'upper'}],
  ['path', {d: 'm3 10 3 3h15l-3-3Z', key: 'middle'}],
  ['path', {d: 'm6 16-3 3h15l3-3Z', key: 'lower'}],
]);

const appletIconNode: IconNode = [
  ['path', {d: 'M3 10h2v4', key: 'one'}],
  ['path', {d: 'M9 12h4m-2-2v4', key: 'plus'}],
  ['rect', {x: 17, y: 10, width: 4, height: 4, rx: 0.5, key: 'zero'}],
];

export const AppletIcon = createLucideIcon('Applet', appletIconNode);

export const CardAppletsIcon = createLucideIcon('CardApplets', [
  ['rect', {x: 2, y: 4, width: 20, height: 16, rx: 2, key: 'card'}],
  ...appletIconNode.map(([tag, attributes]): IconNode[number] => [
    tag,
    {...attributes, transform: 'translate(4.2 4.2) scale(0.65)'},
  ]),
]);
