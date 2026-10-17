import type {ReactNode} from 'react';
import {css, styled} from 'styled-components';

import {TAG_HEIGHT, WhiteTag} from './tag.js';

export const iconTagCSS = css`
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 0;
  min-width: 0;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  isolation: isolate;

  > :first-child {
    flex-shrink: 0;
    z-index: 1;
    width: ${TAG_HEIGHT}px;
    height: ${TAG_HEIGHT}px;
    margin: 0 var(--tag-inline-margin);
    margin-right: calc(-1 * var(--tag-overlap) - var(--tag-inline-margin));
  }
`;

export const IconTag = styled.span`
  ${iconTagCSS}
`;

const NameTag = styled(WhiteTag).attrs({as: 'span'})<{$hasSuffix: boolean}>`
  flex-shrink: 1;
  min-width: 0;
  gap: 2px;
  padding-right: ${props =>
    props.$hasSuffix ? `calc((${TAG_HEIGHT}px - 14px) / 2 - 0.5px)` : '6px'};
  line-height: 20px;

  > :not(:first-child) {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    font-size: 14px;
  }
`;

const Name = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const IconTagName = ({
  children,
  suffix,
}: {
  children: ReactNode;
  suffix?: ReactNode;
}): ReactNode => (
  <NameTag $hasSuffix={!!suffix}>
    <Name>{children}</Name>
    {suffix}
  </NameTag>
);

export const IconTagRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--key-item-gap);
  min-width: 0;
`;
