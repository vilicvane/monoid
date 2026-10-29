import {Clipboard} from '@capacitor/clipboard';
import {useIonAlert} from '@ionic/react';
import {Copy as copy, Trash2 as trash} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useRef,
  useState,
} from 'react';
import {RouteContext} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {
  type DerivedKeyPublicKeyData,
  getSeedKeyDerivationId,
} from '../../@lib/key-derivation.js';
import {AppIcon} from '../@ui/app-icon.js';
import {
  SwipeAction,
  SwipeActionIcon,
  SwipeableItem,
} from '../@ui/swipeable-item.js';

import {KeyList, KeyListItem, KeyListPlaceholder} from './key-list.js';
import {KeyPublicKeyItem} from './key-public-key-item.js';

export const DerivedKeyList = observer(function DerivedKeyList({
  keys,
  compact = false,
  onDelete,
  emptyFocusRef,
}: {
  keys: readonly DerivedKeyPublicKeyData[];
  compact?: boolean;
  onDelete?: (key: DerivedKeyPublicKeyData) => Promise<void>;
  emptyFocusRef?: RefObject<HTMLDivElement | null>;
}): ReactNode {
  const {errorService} = useEntrances();
  const {view} = useContext(RouteContext);
  const active = !view.$leaving && view.$match.$exact.$active;
  const [presentAlert] = useIonAlert();
  const [openKey, setOpenKey] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <KeyList ref={listRef} $compact={compact}>
      {keys.map(key => {
        const {derivation, publicKey} = key;
        const id = getSeedKeyDerivationId(derivation);
        const content = (
          <KeyPublicKeyItem
            key={id}
            curve={derivation.curve}
            context={derivation.context}
            publicKey={publicKey}
            copyable={!onDelete}
          />
        );
        if (!onDelete) return content;
        return (
          <SwipeableItem
            key={id}
            open={openKey === id}
            disabled={!active}
            onOpenChange={open => setOpenKey(open ? id : undefined)}
            actions={
              <>
                <SwipeAction
                  type="button"
                  disabled={!active}
                  onClick={errorService.catch(async () => {
                    await Clipboard.write({string: publicKey});
                    setOpenKey(current =>
                      current === id ? undefined : current,
                    );
                  })}
                >
                  <SwipeActionIcon>
                    <AppIcon icon={copy} aria-hidden="true" />
                  </SwipeActionIcon>
                  Copy
                </SwipeAction>
                <SwipeAction
                  type="button"
                  $color="var(--ion-color-danger)"
                  disabled={!active}
                  onClick={errorService.catch(
                    async (event: MouseEvent<HTMLButtonElement>) => {
                      const row =
                        event.currentTarget.closest<HTMLElement>(
                          '[role="group"]',
                        );
                      await presentAlert({
                        header: 'Delete key?',
                        subHeader: publicKey,
                        message:
                          'Remove this saved key from this device? You can import it again from your card.',
                        buttons: [
                          {text: 'Cancel', role: 'cancel'},
                          {
                            text: 'Delete',
                            role: 'destructive',
                            handler: errorService.catch(async () => {
                              if (view.$leaving || !view.$match.$exact.$active)
                                return;
                              await onDelete(key);
                              setOpenKey(current =>
                                current === id ? undefined : current,
                              );
                            }),
                          },
                        ],
                        onDidDismiss: () => {
                          const nextTarget = row?.isConnected
                            ? row
                            : (listRef.current?.querySelector<HTMLElement>(
                                '[role="group"]',
                              ) ??
                              emptyFocusRef?.current?.querySelector('button'));
                          nextTarget?.focus({preventScroll: true});
                        },
                      });
                    },
                  )}
                >
                  <SwipeActionIcon>
                    <AppIcon icon={trash} aria-hidden="true" />
                  </SwipeActionIcon>
                  Delete
                </SwipeAction>
              </>
            }
          >
            {content}
          </SwipeableItem>
        );
      })}
      {!keys.length && (
        <KeyListItem>
          <KeyListPlaceholder>No derived keys.</KeyListPlaceholder>
        </KeyListItem>
      )}
    </KeyList>
  );
});
