import classNames from 'classNames';
import type {ReactNode} from 'react';
import {useCallback, useId, useState} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {fadeInAnimationCSS, fadeOutAnimationCSS} from '../@animations.js';

import {PopupBackdrop} from './popup-backdrop.js';

const InputContainer = styled.div`
  box-sizing: border-box;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: calc(var(--popup-z-index) + 1);
  padding: calc(var(--view-inset-top) + 24px)
    calc(var(--view-inset-right) + 24px) calc(var(--view-inset-bottom) + 24px)
    calc(var(--view-inset-left) + 24px);
  pointer-events: none;

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  ${fadeInAnimationCSS};

  &.closing {
    ${fadeOutAnimationCSS};
  }

  @media (prefers-reduced-motion: reduce) {
    &,
    &.closing {
      animation-duration: 0s;
    }
  }
`;

const Input = styled.input`
  box-sizing: border-box;
  width: 100%;
  max-width: 420px;
  min-width: 0;
  padding: 12px 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: white;
  line-height: 36px;
  font-size: 28px;
  outline: none;
  pointer-events: auto;

  &::placeholder {
    color: rgba(255, 255, 255, 0.7);
    font-size: 18px;
    opacity: 1;
  }

  &.center {
    text-align: center;
  }
`;

const Description = styled.div`
  width: 100%;
  max-width: 420px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 14px;
  line-height: 20px;

  &.center {
    text-align: center;
  }
`;

export type InputModalOptions = {
  type?: 'text' | 'password';
  center?: boolean;
  placeholder?: string;
  description?: ReactNode;
  defaultValue?: string;
  maxLength?: number;
};

export function useInputModal(): [
  ReactNode,
  (options: InputModalOptions) => Promise<string | undefined>,
] {
  const {
    portals: {popup},
  } = useEntrances();

  const [value, setValue] = useState('');
  const descriptionId = useId();
  const [completion, setCompletion] = useState<{
    value: string | undefined;
  }>();

  const [instance, setInstance] = useState<{
    options: InputModalOptions;
    resolve: (value: string | undefined) => void;
  }>();

  const show = useCallback((options: InputModalOptions) => {
    return new Promise<string | undefined>(resolve => {
      setValue(options.defaultValue ?? '');
      setCompletion(undefined);
      setInstance({options, resolve});
    });
  }, []);

  let content: ReactNode;

  if (instance) {
    const {
      options: {
        type = 'text',
        placeholder,
        description,
        center = false,
        maxLength,
      },
      resolve,
    } = instance;

    const complete = (value: string | undefined): void => {
      setCompletion(current => current ?? {value});
    };

    content = (
      <>
        <PopupBackdrop onDismiss={() => complete(undefined)} />
        {createPortal(
          <InputContainer
            className={classNames({closing: completion})}
            onAnimationEnd={event => {
              if (event.target !== event.currentTarget || !completion) {
                return;
              }

              setValue('');
              setCompletion(undefined);
              setInstance(undefined);
              resolve(completion.value);
            }}
          >
            <Input
              className={classNames({center})}
              type={type}
              placeholder={placeholder}
              aria-label={placeholder}
              aria-describedby={description != null ? descriptionId : undefined}
              value={value}
              maxLength={maxLength}
              readOnly={!!completion}
              autoFocus
              onChange={event => setValue(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter') {
                  return;
                }

                complete(value);
              }}
              onBlur={() => complete(undefined)}
            />
            {description != null && (
              <Description id={descriptionId} className={classNames({center})}>
                {description}
              </Description>
            )}
          </InputContainer>,
          popup,
        )}
      </>
    );
  }

  return [content, show];
}
