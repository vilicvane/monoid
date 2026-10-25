import {type CloseSessionOptions, IsoDepNfc} from 'capacitor-isodep-nfc';

import {standbyIsoDep} from './isodep.js';

export type AppletCommandDefinition = {
  request: unknown;
  response: unknown;
};

type AppletResponse = {
  data: Uint8Array;
  sw: number;
  sw1: number;
  sw2: number;
};

export abstract class Applet<TCommandDefinitions> {
  private sessionId?: string;

  constructor(readonly aid: Uint8Array) {}

  /** Select another applet without closing the caller's NFC connection. */
  async useSession(source: Applet<unknown>): Promise<this> {
    if (source.sessionId === undefined) {
      throw new Error('Applet commands require an open NFC session.');
    }

    return this.openSession(source.sessionId);
  }

  standby(
    callback: (applet: this) => Promise<void>,
    onError: (error: unknown) => void = console.error,
    /** Called after a connection attempt or a failed scan has been cleaned up. */
    onCleanup?: () => void,
    /** Reports native connection changes, including the SELECT exchange. */
    onConnectionChange?: (connected: boolean, sessionId?: string) => void,
    /** Evaluated after the operation or onError, before connection cleanup. */
    getCloseOptions?: () => Omit<CloseSessionOptions, 'sessionId'>,
    /** Handles a missing SELECT target while its raw connection is still open. */
    onNotFound?: (sessionId: string) => Promise<void>,
  ): () => Promise<void> {
    return standbyIsoDep(
      async sessionId => {
        let applet: this;

        try {
          applet = await this.openSession(sessionId);
        } catch (error) {
          if (error instanceof AppletNotFoundError && onNotFound) {
            await onNotFound(sessionId);
            return;
          }

          throw error;
        }

        await callback(applet);
      },
      onError,
      onCleanup,
      onConnectionChange,
      getCloseOptions,
    );
  }

  /** Select on an existing connection; the caller retains ownership of its lifetime. */
  async openSession(sessionId: string): Promise<this> {
    const applet = Object.create(this) as this;
    applet.sessionId = sessionId;

    await applet.select();

    return applet;
  }

  async sendCommand<TIns extends keyof TCommandDefinitions & number>(
    ins: TIns,
    data: (TCommandDefinitions[TIns] & AppletCommandDefinition)['request'],
  ): Promise<(TCommandDefinitions[TIns] & AppletCommandDefinition)['response']>;
  async sendCommand(ins: number, data: unknown): Promise<unknown> {
    const payload = this.encode(data, ins);

    if (payload.length === 0 || payload.length > 8192) {
      throw new RangeError(
        'Encoded applet requests must contain 1–8192 bytes.',
      );
    }

    for (let offset = 0; ; offset += 255) {
      const frame = payload.subarray(offset, offset + 255);
      const last = offset + frame.length === payload.length;
      const cla =
        payload.length <= 255 ? 0x00 : offset === 0 ? 0x90 : last ? 0xa0 : 0xb0;
      const response = await this.transceive(
        new Uint8Array([cla, ins, 0x00, 0x00, frame.length, ...frame]),
      );

      if (last) {
        return this.decode(await this.readResponse(response));
      }

      if (response.sw !== 0x9000 || response.data.length !== 0) {
        throw new Error(
          'Expected an empty acknowledgement for an APDU fragment.',
        );
      }
    }
  }

  private async select(): Promise<void> {
    let response: AppletResponse;

    try {
      response = await this.transceive(
        new Uint8Array([0x00, 0xa4, 0x04, 0x00, this.aid.length, ...this.aid]),
      );
    } catch (error) {
      if (error instanceof AppletISOError && isAppletNotFoundStatus(error.sw)) {
        throw new AppletNotFoundError(error.data);
      }

      throw error;
    }

    // A failure fetching SELECT's remaining data does not mean it is absent.
    await this.readResponse(response);
  }

  public async sendRawCommand(command: Uint8Array): Promise<Uint8Array> {
    return this.readResponse(await this.transceive(command));
  }

  private async transceive(command: Uint8Array): Promise<AppletResponse> {
    const {sessionId} = this;

    if (sessionId === undefined) {
      throw new Error('Applet commands require an open NFC session.');
    }

    const {data: response} = await IsoDepNfc.transceive({
      sessionId,
      data: Array.from(command),
    });
    const parsed = Applet.parseResponse(response);

    if (parsed.sw !== 0x9000 && parsed.sw1 !== 0x61) {
      throw new AppletISOError(
        'Failed to request more data.',
        parsed.sw,
        parsed.data,
      );
    }

    return parsed;
  }

  private async readResponse(response: AppletResponse): Promise<Uint8Array> {
    let buffer = response.data;

    while (response.sw1 === 0x61) {
      response = await this.transceive(
        new Uint8Array([0x00, 0xc0, 0x00, 0x00, response.sw2]),
      );
      buffer = new Uint8Array([...buffer, ...response.data]);
    }

    return buffer;
  }

  protected abstract encode(data: unknown, ins: number): Uint8Array;

  protected abstract decode(data: Uint8Array): unknown;

  private static parseResponse(response: number[]): AppletResponse {
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
  [0x6883, 'No matching request in progress'],
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

/**
 * Whether a SELECT status word means no applet has the AID. Java Card passes a
 * SELECT without a matching applet to the currently selected one, which rejects
 * the instruction as unsupported; a selected target never answers that way.
 */
export function isAppletNotFoundStatus(sw: number): boolean {
  return sw === 0x6a82 || sw === 0x6d00;
}

export class AppletNotFoundError extends AppletISOError {
  constructor(data: Uint8Array) {
    super('Applet not found during SELECT', 0x6a82, data);
  }
}
