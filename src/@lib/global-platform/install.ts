import {hexToUint8Array} from '../../@utils/index.js';

import {
  type CardTransceive,
  concat,
  equalBytes,
  lengthValue,
  parseResponse,
  readTLV,
  shortCommand,
  successful,
} from './commands.js';
import {openSecureChannel} from './secure-channel.js';

export type AppletPackage = {
  packageAid: Uint8Array;
  appletAid: Uint8Array;
  code: Uint8Array;
};

export type GlobalPlatformInstallProgress =
  | {phase: 'checking' | 'configuring' | 'complete'}
  | {phase: 'uploading'; progress: number};

type RegistryEntry = {
  lifecycle: number;
  modules: Uint8Array[];
};

/** Bootstrap only: installs missing applets, never deletes or replaces card content. */
export class GlobalPlatformInstaller {
  private constructor(
    private readonly transceive: CardTransceive,
    private readonly domainAid: Uint8Array,
  ) {}

  static async open(
    transceive: CardTransceive,
  ): Promise<GlobalPlatformInstaller> {
    // ISDs on the project's NXP cards. Only NOT FOUND permits another SELECT.
    for (const hex of ['a000000151000000', 'a000000003000000']) {
      const aid = hexToUint8Array(hex);
      const response = await transceive(
        shortCommand(0xa4, 0x04, 0x00, aid, 0x00),
      );

      if (parseResponse(response).sw === 0x6a82) {
        continue;
      }

      successful(response, 'Selecting the card manager');
      const channel = await openSecureChannel(transceive);

      return new GlobalPlatformInstaller(
        command => channel.transceive(command),
        aid,
      );
    }

    throw new Error('A supported card manager was not found on this card.');
  }

  async install(
    applet: AppletPackage,
    onProgress: (update: GlobalPlatformInstallProgress) => void,
  ): Promise<void> {
    onProgress({phase: 'checking'});

    const instance = await this.findEntry(0x40, applet.appletAid);

    if (instance) {
      if ((instance.lifecycle & 0x87) !== 0x07) {
        throw new Error(
          'The existing applet is not selectable. Its data has been left unchanged.',
        );
      }

      onProgress({phase: 'complete'});
      return;
    }

    const loaded = await this.findEntry(0x10, applet.packageAid);

    if (loaded) {
      if (
        loaded.lifecycle !== 0x01 ||
        !loaded.modules.some(aid => equalBytes(aid, applet.appletAid))
      ) {
        throw new Error(
          'An incomplete or different applet package is already on this card. Its data has been left unchanged.',
        );
      }
    } else {
      await this.load(applet, onProgress);
    }

    onProgress({phase: 'configuring'});

    // No privileges, no installation parameters, no delegated-management token.
    const data = concat(
      lengthValue(applet.packageAid),
      lengthValue(applet.appletAid),
      lengthValue(applet.appletAid),
      new Uint8Array([1, 0, 2, 0xc9, 0, 0]),
    );
    successful(
      await this.transceive(shortCommand(0xe6, 0x0c, 0, data)),
      'Installing the applet',
    );

    const installed = await this.findEntry(0x40, applet.appletAid);

    if (!installed || (installed.lifecycle & 0x87) !== 0x07) {
      throw new Error(
        'The card did not confirm a selectable applet after installation.',
      );
    }

    onProgress({phase: 'complete'});
  }

  private async load(
    applet: AppletPackage,
    onProgress: (update: GlobalPlatformInstallProgress) => void,
  ): Promise<void> {
    const {code} = applet;
    const blockSize = 220;

    if (code.length === 0 || code.length > 0xffff) {
      throw new Error('Invalid applet load file size.');
    }

    const length =
      code.length < 0x80
        ? [code.length]
        : code.length <= 0xff
          ? [0x81, code.length]
          : [0x82, code.length >> 8, code.length & 0xff];
    const loadFile = concat(new Uint8Array([0xc4, ...length]), code);
    const blocks = Math.ceil(loadFile.length / blockSize);

    if (blocks > 256) {
      throw new Error('Applet load file needs too many transfer blocks.');
    }

    successful(
      await this.transceive(
        shortCommand(
          0xe6,
          0x02,
          0,
          concat(
            lengthValue(applet.packageAid),
            lengthValue(this.domainAid),
            new Uint8Array([0, 0, 0]),
          ),
        ),
      ),
      'Preparing the applet transfer',
    );

    onProgress({phase: 'uploading', progress: 0});

    for (let index = 0; index < blocks; index++) {
      const final = index === blocks - 1;
      const block = loadFile.subarray(
        index * blockSize,
        (index + 1) * blockSize,
      );

      successful(
        await this.transceive(
          shortCommand(0xe8, final ? 0x80 : 0x00, index, block),
        ),
        'Transferring the applet',
      );
      onProgress({phase: 'uploading', progress: (index + 1) / blocks});
    }
  }

  private async findEntry(
    scope: number,
    aid: Uint8Array,
  ): Promise<RegistryEntry | undefined> {
    const chunks: Uint8Array[] = [];

    for (let page = 0; page < 256; page++) {
      const response = await this.transceive(
        shortCommand(
          0xf2,
          scope,
          page ? 0x03 : 0x02,
          concat(new Uint8Array([0x4f]), lengthValue(aid)),
        ),
      );
      const {data, sw} = parseResponse(response);

      if (sw === 0x6a88 && page === 0) {
        return undefined;
      }

      if (sw !== 0x9000 && sw !== 0x6310) {
        successful(response, 'Reading the card registry');
      }

      chunks.push(data);

      if (sw === 0x6310) {
        if (!data.length) {
          throw new Error('The card registry did not finish responding.');
        }

        continue;
      }

      for (const record of readTLV(concat(...chunks))) {
        if (record.tag !== 0xe3) {
          throw new Error('Unsupported card registry format.');
        }

        const fields = readTLV(record.value);
        const entryAid = fields.find(field => field.tag === 0x4f)?.value;
        const lifecycle = fields.find(field => field.tag === 0x9f70)?.value;

        if (
          !entryAid ||
          entryAid.length < 5 ||
          entryAid.length > 16 ||
          lifecycle?.length !== 1
        ) {
          throw new Error('Missing or invalid card registry fields.');
        }

        if (equalBytes(entryAid, aid)) {
          return {
            lifecycle: lifecycle[0],
            modules: fields
              .filter(field => field.tag === 0x84)
              .map(field => field.value),
          };
        }
      }

      return undefined;
    }

    throw new Error('The card registry did not finish responding.');
  }
}
