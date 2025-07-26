import {decode, encode} from 'cbor2';
import type * as x from 'x-value';

import type {AppletCommandDefinition} from './applet.js';
import {Applet} from './applet.js';

export class CBORApplet<
  TCommandDefinitions,
> extends Applet<TCommandDefinitions> {
  protected encode(data: unknown): Uint8Array {
    return encode(data);
  }

  protected decode(data: Uint8Array): unknown {
    return decode(data);
  }

  static create<TCBORCommandDefinitions extends CBORCommandDefinitions>(
    aid: Uint8Array,
    definitions: TCBORCommandDefinitions,
  ): CBORApplet<
    CBORCommandDefinitionsToAppletCommandDefinitions<TCBORCommandDefinitions>
  > &
    CBORCommandDefinitionsToMethods<TCBORCommandDefinitions> {
    return Object.create(
      new CBORApplet(aid),
      Object.fromEntries(
        Object.entries(definitions).map(([key, definition]) => [
          key,
          {
            async value(
              this: CBORApplet<Record<number, AppletCommandDefinition>>,
              request: unknown,
            ) {
              const response = await this.sendCommand(
                definition.ins,
                definition.request.satisfies(request),
              );

              return definition.response.satisfies(response);
            },
          },
        ]),
      ),
    );
  }
}

export type CBORCommandDefinitions = Record<string, CBORCommandDefinition>;

export type CBORCommandDefinition = {
  ins: number;
  request: x.XTypeOfValue<object>;
  response: x.XTypeOfValue<object>;
};

type CBORCommandDefinitionsToAppletCommandDefinitions<
  TCBORCommandDefinitions extends CBORCommandDefinitions,
> = {
  [TIns in TCBORCommandDefinitions[string]['ins']]: TCBORCommandDefinitions[string] & {
    ins: TIns;
  } extends infer TCBORCommandDefinition extends CBORCommandDefinition
    ? {
        request: x.TypeOf<TCBORCommandDefinition['request']>;
        response: x.TypeOf<TCBORCommandDefinition['response']>;
      }
    : never;
};

type CBORCommandDefinitionsToMethods<
  TCBORCommandDefinitions extends CBORCommandDefinitions,
> = {
  [TCommandName in keyof TCBORCommandDefinitions]: (
    request: x.TypeOf<TCBORCommandDefinitions[TCommandName]['request']>,
  ) => Promise<x.TypeOf<TCBORCommandDefinitions[TCommandName]['response']>>;
};
