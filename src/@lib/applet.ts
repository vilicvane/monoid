import {IsoDepNfc} from 'capacitor-isodep-nfc';

import {standbyIsoDep} from './isodep.js';

export type AppletCommandDefinition = {
  request: unknown;
  response: unknown;
};

export abstract class Applet<TCommandDefinitions> {
  private sessionId?: string;

  constructor(readonly aid: Uint8Array) {}

  standby(
    callback: (applet: this) => Promise<void>,
    onError: (error: unknown) => void = console.error,
    /** Called after a connection attempt or a failed scan has been cleaned up. */
    onCleanup?: () => void,
  ): () => Promise<void> {
    return standbyIsoDep(
      async sessionId => {
        const applet = Object.create(this) as this;
        applet.sessionId = sessionId;

        await applet.select();
        await callback(applet);
      },
      onError,
      onCleanup,
    );
  }

  async sendCommand<TIns extends keyof TCommandDefinitions & number>(
    ...args:
      | [
          ins: TIns,
          data: (TCommandDefinitions[TIns] &
            AppletCommandDefinition)['request'],
        ]
      | [
          cla: number,
          ins: TIns,
          p1: number,
          p2: number,
          data: (TCommandDefinitions[TIns] &
            AppletCommandDefinition)['request'],
        ]
  ): Promise<(TCommandDefinitions[TIns] & AppletCommandDefinition)['response']>;
  async sendCommand(
    ...args:
      | [ins: number, data: unknown]
      | [cla: number, ins: number, p1: number, p2: number, data: unknown]
  ): Promise<unknown> {
    let cla: number;
    let ins: number;
    let p1: number;
    let p2: number;

    let data: unknown;

    if (args.length === 2) {
      [ins, data] = args;
      cla = 0x00;
      p1 = 0x00;
      p2 = 0x00;
    } else {
      [cla, ins, p1, p2, data] = args;
    }

    const cbor = this.encode(data);

    const command = new Uint8Array([cla, ins, p1, p2, cbor.length, ...cbor]);

    const response = await this.sendRawCommand(command);

    return this.decode(response);
  }

  private async select(): Promise<void> {
    await this.sendRawCommand(
      new Uint8Array([0x00, 0xa4, 0x04, 0x00, this.aid.length, ...this.aid]),
    );
  }

  public async sendRawCommand(command: Uint8Array): Promise<Uint8Array> {
    const {sessionId} = this;

    if (sessionId === undefined) {
      throw new Error('Applet commands require an open NFC session.');
    }

    let {data: response} = await IsoDepNfc.transceive({
      sessionId,
      data: Array.from(command),
    });

    let buffer = new Uint8Array(0);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const {data, sw, sw1} = Applet.parseResponse(response);

      buffer = new Uint8Array([...buffer, ...data]);

      if (sw === 0x9000) {
        break;
      }

      if (sw1 === 0x61) {
        // More data is available.

        const {data: nextResponse} = await IsoDepNfc.transceive({
          sessionId,
          data: [0x00, 0xc0, 0x00, 0x00],
        });

        response = nextResponse;

        continue;
      }

      throw new AppletISOError('Failed to request more data.', sw, data);
    }

    return buffer;
  }

  protected abstract encode(data: unknown): Uint8Array;

  protected abstract decode(data: Uint8Array): unknown;

  private static parseResponse(response: number[]): {
    data: Uint8Array;
    sw: number;
    sw1: number;
    sw2: number;
  } {
    if (response.length < 2) {
      throw new Error('Invalid response length');
    }

    const data = response.slice(0, -2);
    const sw1 = response[response.length - 2];
    const sw2 = response[response.length - 1];
    const sw = (sw1 << 8) | sw2;

    return {data: new Uint8Array(data), sw, sw1, sw2};
  }
}

const ISO7816_SW_CODE_TEXT_MAP = new Map([
  [0x9000, 'No Error'],
  [0x6100, 'Response bytes remaining'],
  [0x6700, 'Wrong length'],
  [0x6982, 'Security condition not satisfied'],
  [0x6983, 'File invalid'],
  [0x6984, 'Data invalid'],
  [0x6985, 'Conditions of use not satisfied'],
  [0x6986, 'Command not allowed (no current EF)'],
  [0x6999, 'Applet selection failed'],
  [0x6a80, 'Wrong data'],
  [0x6a81, 'Function not supported'],
  [0x6a82, 'File not found'],
  [0x6a83, 'Record not found'],
  [0x6a86, 'Incorrect parameters (P1,P2)'],
  [0x6b00, 'Wrong P1,P2'],
  [0x6c00, 'Correct Expected Length (Le)'],
  [0x6d00, 'INS value not supported'],
  [0x6e00, 'CLA value not supported'],
  [0x6f00, 'No precise diagnosis'],
  [0x6a84, 'Not enough memory space in the file'],
]);

export class AppletISOError extends Error {
  constructor(
    note: string,
    readonly sw: number,
    readonly data: Uint8Array,
  ) {
    super(
      `0x${sw.toString(16).padStart(4, '0')} ${ISO7816_SW_CODE_TEXT_MAP.get(sw) ?? 'Unknown SW'} (${note}).`,
    );
    this.name = new.target.name;
  }
}
