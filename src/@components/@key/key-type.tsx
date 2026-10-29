import type {ReactNode} from 'react';

export function getKeyTypeName(type: string): string {
  switch (type) {
    case 'ed25519':
    case 'secp256k1':
    case 'secp256r1':
      return type;
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

export const KeyType = ({type}: {type: string}): ReactNode =>
  getKeyTypeName(type);
