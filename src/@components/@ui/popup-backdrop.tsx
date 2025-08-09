import {type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {useEntrances} from '../../@entrances.js';
import {fadeInAnimationCSS, fadeOutAnimationCSS} from '../@animations.js';

const Container = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);

  z-index: var(--popup-z-index);

  ${fadeInAnimationCSS};

  &.unmount {
    ${fadeOutAnimationCSS};
  }
`;

export const PopupBackdrop = ({
  onDismiss,
}: {
  onDismiss?: () => void;
}): ReactNode => {
  const {
    portals: {popup},
  } = useEntrances();

  return createPortal(
    <UnmountAnimationClone>
      <Container
        onClick={event => {
          if (event.target !== event.currentTarget) {
            return;
          }

          onDismiss?.();
        }}
      />
    </UnmountAnimationClone>,
    popup,
  );
};
