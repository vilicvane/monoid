import {Nfc, NfcTagTechType} from '@capawesome-team/capacitor-nfc';
import {decode, encode} from 'cbor2';

export class JavaCardApplet {
  constructor(readonly aid: Uint8Array) {}

  async sendCommand(ins: number, data: unknown): Promise<void> {
    await Nfc.connect({
      techType: NfcTagTechType.IsoDep,
    });

    await this.select();

    const cbor = encode(data);

    const command = new Uint8Array([
      0x00, // CLA
      ins, // INS
      0x00, // P1
      0x00, // P2
      cbor.length, // Lc
      ...cbor, // Data
    ]);

    console.log(
      `Sending command to JavaCard applet with AID ${uint8ArrayToHex(
        this.aid,
      )}`,
    );
    console.log(uint8ArrayToHex(command));

    let {response} = await Nfc.transceive({
      data: Array.from(command),
    });

    let buffer = new Uint8Array(0);

    while (true) {
      const {
        data: responseData,
        sw,
        sw1,
      } = JavaCardApplet.parseResponse(response);

      buffer = new Uint8Array([...buffer, ...responseData]);

      if (sw === 0x9000) {
        break;
      }

      if (sw1 === 0x61) {
        const {response: nextResponse} = await Nfc.transceive({
          data: Array.from(new Uint8Array([0x00, 0xc0, 0x00, 0x00])),
        });

        response = nextResponse;

        continue;
      }

      throw new Error(
        `Failed to send command to applet: ${responseData.toString()}`,
      );
    }

    const responseObject = decode(buffer);

    console.log('JavaCard response:', responseObject);

    await Nfc.close();
  }

  private async select(): Promise<void> {
    const selectCommand = new Uint8Array([
      0x00, // CLA
      0xa4, // INS
      0x04, // P1
      0x00, // P2
      this.aid.length, // Lc
      ...this.aid, // AID
    ]);

    const {response} = await Nfc.transceive({
      data: Array.from(selectCommand),
    });

    const {data, sw} = JavaCardApplet.parseResponse(response);

    if (sw !== 0x9000) {
      throw new Error(`Failed to select applet: ${data.toString()}`);
    }
  }

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

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}
