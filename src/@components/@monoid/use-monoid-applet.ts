import {useEffect} from 'react';

import {useEntrances} from '../../@entrances.js';
import type {createMonoidApplet} from '../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';

export function useMonoidApplet(
  callback: (applet: ReturnType<typeof createMonoidApplet>) => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const {router, monoidApplet} = useEntrances();

  useEffect(
    () =>
      monoidApplet.standby(
        async applet => {
          const hello = await applet.hello({});

          if (hello.pin === false) {
            router.safe
              .setupCard({
                pin: hello.safe.pin !== false,
                safe: {
                  id: uint8ArrayToHex(hello.safe.id),
                  pin: hello.safe.pin !== false,
                  unlocked: hello.safe.unlocked,
                },
              })
              .$push();

            return;
          }

          await callback(applet);
        },
        error => {
          onError(error);
        },
      ),
    [callback, monoidApplet, onError, router.safe],
  );
}
