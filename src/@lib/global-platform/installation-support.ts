import type {CardInformation} from './card-information.js';
import {SCP03_S8_VARIANTS} from './secure-channel.js';

export type CardInstallationCheck = {label: string; supported: boolean};

export type CardExpectedCryptography = {
  label: string;
  evidence: string[];
  limitations: string;
};

type ChannelProfile = {
  protocol: string;
  variant: number;
  keys?: string[];
};

/** Checks reported management capabilities, not credentials or applet runtime. */
export function getCardInstallationChecks(
  information: CardInformation,
): CardInstallationCheck[] {
  const profiles: ChannelProfile[] =
    information.capabilities?.secureChannels.flatMap(channel =>
      channel.options.map(option => ({
        protocol: channel.protocol,
        variant: Number.parseInt(option, 16),
        keys: channel.keys.length ? channel.keys : undefined,
      })),
    ) ?? [];

  for (const channel of information.secureChannels) {
    const match = /^(SCP[0-9A-F]{2}) i=([0-9a-f]{2})$/.exec(channel);

    if (!match) continue;

    const [, protocol, option] = match;
    const variant = Number.parseInt(option, 16);

    if (
      !profiles.some(
        profile => profile.protocol === protocol && profile.variant === variant,
      )
    ) {
      profiles.push({protocol, variant});
    }
  }

  const scp03Profiles = profiles.filter(
    profile =>
      profile.protocol === 'SCP03' &&
      SCP03_S8_VARIANTS.includes(profile.variant),
  );
  const scp03 =
    scp03Profiles.find(profile => profile.keys?.includes('AES-128')) ??
    scp03Profiles.find(profile => profile.keys === undefined) ??
    scp03Profiles[0];
  const scp02 = profiles.some(
    profile => profile.protocol === 'SCP02' && profile.variant === 0x55,
  );

  if (scp03 && (!scp02 || !scp03.keys || scp03.keys.includes('AES-128'))) {
    return [
      {label: 'SCP03 S8', supported: true},
      ...(scp03.keys
        ? [{label: 'AES-128', supported: scp03.keys.includes('AES-128')}]
        : []),
    ];
  }

  if (scp02) {
    return [{label: 'SCP02 i=55', supported: true}];
  }

  return [...new Set(profiles.map(profile => profile.protocol))].map(
    protocol => ({
      label:
        protocol === 'SCP03'
          ? 'SCP03 S8'
          : protocol === 'SCP02'
            ? 'SCP02 i=55'
            : protocol,
      supported: false,
    }),
  );
}

/** GP declarations provide preliminary evidence, not an applet runtime test. */
export function getCardExpectedCryptography(
  information: CardInformation,
): CardExpectedCryptography[] {
  const evidence = {
    AES: new Set<string>(),
    ECC: new Set<string>(),
    RSA: new Set<string>(),
    'SHA-2': new Set<string>(),
  };
  const bitLengths: Partial<Record<keyof typeof evidence, Set<number>>> = {};
  const {capabilities} = information;

  function addEvidence(
    algorithm: keyof typeof evidence,
    source: string,
    bits?: number,
  ): void {
    evidence[algorithm].add(source);

    if (bits !== undefined) {
      (bitLengths[algorithm] ??= new Set()).add(bits);
    }
  }

  for (const channel of information.secureChannels) {
    if (/^SCP03 i=[0-9a-f]{2}$/.test(channel)) {
      evidence.AES.add(`Secure channel: ${channel}`);
    }
  }

  for (const channel of capabilities?.secureChannels ?? []) {
    if (channel.protocol === 'SCP03') {
      evidence.AES.add(
        `Secure channel: ${channel.protocol} ${channel.options.map(option => `i=${option}`).join(', ')}`,
      );

      for (const key of channel.keys) {
        if (['AES-128', 'AES-192', 'AES-256'].includes(key)) {
          addEvidence('AES', `SCP03 keys: ${key}`, Number(key.slice(4)));
        }
      }
    }
  }

  for (const cipher of capabilities?.loadFileCiphers ?? []) {
    if (['AES-128', 'AES-192', 'AES-256'].includes(cipher)) {
      addEvidence(
        'AES',
        `Load file encryption: ${cipher}`,
        Number(cipher.slice(4)),
      );
    }
  }

  for (const hash of capabilities?.loadFileHashes ?? []) {
    if (hash === 'SHA-256' || hash === 'SHA-512') {
      addEvidence('SHA-2', `Load file hash: ${hash}`, Number(hash.slice(4)));
    }
  }

  const signatureAlgorithms: Record<
    string,
    | readonly (readonly [algorithm: keyof typeof evidence, bits?: number])[]
    | undefined
  > = {
    RSA1024_SHA1: [['RSA', 1024]],
    RSAPSS_SHA256: [['RSA'], ['SHA-2', 256]],
    CMAC_AES128: [['AES', 128]],
    CMAC_AES192: [['AES', 192]],
    CMAC_AES256: [['AES', 256]],
    ECCP256_SHA256: [
      ['ECC', 256],
      ['SHA-2', 256],
    ],
    ECCP384_SHA384: [['ECC', 384]],
    ECCP512_SHA512: [
      ['ECC', 512],
      ['SHA-2', 512],
    ],
    ECCP521_SHA512: [
      ['ECC', 521],
      ['SHA-2', 512],
    ],
  };
  const signatureUses = [
    ['Token verification', capabilities?.tokenVerificationCiphers],
    ['Receipt generation', capabilities?.receiptGenerationCiphers],
    ['DAP verification', capabilities?.dapVerificationCiphers],
  ] as const;

  for (const [use, ciphers] of signatureUses) {
    for (const cipher of ciphers ?? []) {
      for (const [algorithm, bits] of signatureAlgorithms[cipher] ?? []) {
        addEvidence(algorithm, `${use}: ${cipher}`, bits);
      }
    }
  }

  const limitations = {
    AES: 'Does not confirm Java Card AES-128 ECB or shared access.',
    ECC: 'Does not confirm custom curves, ECDH PLAIN_XY, or shared access.',
    RSA: 'Does not confirm RSA-512 or private RSA NOPAD.',
    'SHA-2': 'Does not confirm Java Card digest APIs or OneShot support.',
  };

  return (Object.keys(evidence) as (keyof typeof evidence)[])
    .filter(
      label =>
        evidence[label].size &&
        (label !== 'AES' || !bitLengths.AES?.size || bitLengths.AES.has(128)),
    )
    .map(label => {
      const bits = [...(bitLengths[label] ?? [])]
        .filter(bits => label !== 'AES' || bits === 128)
        .sort((a, b) => a - b);

      return {
        label: bits.length ? `${label} · ${bits.join(' / ')}-bit` : label,
        evidence: [...evidence[label]],
        limitations: limitations[label],
      };
    });
}
