import classNames from 'classNames';
import type {ReactNode} from 'react';
import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {fadeInAnimationCSS, fadeOutAnimationCSS} from '../@animations.js';

import {PopupBackdrop} from './popup-backdrop.js';
import {popupContentPaddingCSS} from './popup-layout.js';

const InputContainer = styled.div`
  box-sizing: border-box;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: calc(var(--popup-z-index) + 1);
  ${popupContentPaddingCSS};
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

const InputField = styled.div`
  position: relative;
  width: 100%;
  max-width: 420px;
  min-width: 0;

  &.center {
    text-align: center;
  }
`;

const Input = styled.input`
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  width: 100%;
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
  text-align: inherit;

  &::placeholder {
    color: rgba(255, 255, 255, 0.7);
    font-size: 18px;
    opacity: 1;
  }

  &.rich-placeholder::placeholder {
    color: transparent;
  }
`;

const Placeholder = styled.div`
  position: absolute;
  inset: 0;
  padding: 12px 0;
  color: rgba(255, 255, 255, 0.7);
  font-size: 18px;
  line-height: 36px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
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
  placeholderContent?: ReactNode;
  description?: ReactNode;
  defaultValue?: string;
  maxLength?: number;
};

type InputModalInstance = {
  id: number;
  options: InputModalOptions;
  resolve: (value: string | undefined) => void;
  release: () => void;
};

export function useInputModal(): [
  ReactNode,
  (
    options: InputModalOptions,
    signal?: AbortSignal,
  ) => Promise<string | undefined>,
] {
  const {
    portals: {popup},
  } = useEntrances();

  const [value, setValue] = useState('');
  const descriptionId = useId();
  const nextInstanceId = useRef(0);
  const activeInstance = useRef<InputModalInstance | undefined>(undefined);
  const [completion, setCompletion] = useState<{
    value: string | undefined;
  }>();
  const [instance, setInstance] = useState<InputModalInstance>();

  const close = useCallback(
    (
      current: InputModalInstance,
      result: string | undefined,
      updateState = true,
    ) => {
      if (activeInstance.current !== current) return;
      activeInstance.current = undefined;
      current.release();
      if (updateState) {
        setValue('');
        setCompletion(undefined);
        setInstance(undefined);
      }
      current.resolve(result);
    },
    [],
  );

  useEffect(
    () => () => {
      if (activeInstance.current) {
        close(activeInstance.current, undefined, false);
      }
    },
    [close],
  );

  const show = useCallback(
    (options: InputModalOptions, signal?: AbortSignal) => {
      if (signal?.aborted) return Promise.resolve(undefined);
      return new Promise<string | undefined>(resolve => {
        if (activeInstance.current) close(activeInstance.current, undefined);
        const cancel = (): void => close(current, undefined);
        const current: InputModalInstance = {
          id: nextInstanceId.current++,
          options,
          resolve,
          release: () => signal?.removeEventListener('abort', cancel),
        };
        activeInstance.current = current;
        setValue(options.defaultValue ?? '');
        setCompletion(undefined);
        setInstance(current);
        signal?.addEventListener('abort', cancel, {once: true});
      });
    },
    [close],
  );

  let content: ReactNode;

  if (instance) {
    const {
      options: {
        type = 'text',
        placeholder,
        placeholderContent,
        description,
        center = false,
        maxLength,
      },
    } = instance;

    const complete = (value: string | undefined): void => {
      if (activeInstance.current !== instance) return;
      setCompletion(current => current ?? {value});
    };

    content = (
      <>
        <PopupBackdrop onDismiss={() => complete(undefined)} />
        {createPortal(
          <InputContainer
            key={instance.id}
            className={classNames({closing: completion})}
            onAnimationEnd={event => {
              if (event.target !== event.currentTarget || !completion) {
                return;
              }

              close(instance, completion.value);
            }}
          >
            <InputField className={classNames({center})}>
              <Input
                className={classNames({
                  'rich-placeholder': placeholderContent != null,
                })}
                type={type}
                placeholder={placeholder}
                aria-label={placeholder}
                aria-describedby={
                  description != null ? descriptionId : undefined
                }
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
              {placeholderContent != null && !value && (
                <Placeholder aria-hidden="true">
                  {placeholderContent}
                </Placeholder>
              )}
            </InputField>
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
