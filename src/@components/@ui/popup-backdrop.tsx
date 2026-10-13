import {type ReactNode, useLayoutEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

const Container = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: calc(var(--popup-z-index) + 1);
`;

export const PopupBackdrop = ({
  onDismiss,
}: {
  onDismiss?: () => void;
}): ReactNode => {
  const {
    portals: {popup, popupBackdrop},
    errorService,
  } = useEntrances();

  const [owner] = useState(() => Symbol());

  useLayoutEffect(() => {
    errorService.catch(popupBackdrop.acquire(owner));

    return () => {
      errorService.catch(popupBackdrop.release(owner));
    };
  }, [popupBackdrop, owner, errorService]);

  return createPortal(
    <Container
      onClick={event => {
        if (event.target !== event.currentTarget) {
          return;
        }

        onDismiss?.();
      }}
    />,
    popup,
  );
};
