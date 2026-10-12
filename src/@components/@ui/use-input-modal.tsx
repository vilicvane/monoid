import classNames from 'classNames';
import type {ReactNode} from 'react';
import {useCallback, useState} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {useEntrances} from '../../@entrances.js';
import {fadeInAnimationCSS, fadeOutAnimationCSS} from '../@animations.js';

import {PopupBackdrop} from './popup-backdrop.js';

const Input = styled.input`
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100vh - 50px);

  border: none;
  padding: 15px;
  line-height: 20px;
  font-size: 18px;

  outline: none;

  z-index: var(--popup-z-index);

  &.center {
    text-align: center;
  }

  ${fadeInAnimationCSS};

  &.unmount {
    ${fadeOutAnimationCSS};
  }
`;

export type InputModalOptions = {
  type?: 'text' | 'password';
  center?: boolean;
  placeholder?: string;
};

export function useInputModal(): [
  ReactNode,
  (options: InputModalOptions) => Promise<string | undefined>,
] {
  const {
    portals: {popup},
  } = useEntrances();

  const [value, setValue] = useState('');

  const [instance, setInstance] = useState<{
    options: InputModalOptions;
    resolve: (value: string | undefined) => void;
    reject: (error: unknown) => void;
  }>();

  const show = useCallback((options: InputModalOptions) => {
    console.log('useInputModal.show', options);

    return new Promise<string | undefined>((resolve, reject) => {
      setInstance({options, resolve, reject});
    });
  }, []);

  let content: ReactNode;

  if (instance) {
    const {
      options: {type = 'text', placeholder, center = false},
      resolve,
      reject,
    } = instance;

    const dismiss = (): void => {
      setInstance(undefined);
      resolve(undefined);
    };

    content = (
      <>
        <PopupBackdrop onDismiss={dismiss} />
        {createPortal(
          <UnmountAnimationClone>
            <Input
              className={classNames({center})}
              type={type}
              placeholder={placeholder}
              value={value}
              autoFocus
              onChange={event => setValue(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter') {
                  return;
                }

                setValue('');
                setInstance(undefined);
                resolve(value);
              }}
              onBlur={dismiss}
            />
          </UnmountAnimationClone>,
          popup,
        )}
      </>
    );
  }

  return [content, show];
}
