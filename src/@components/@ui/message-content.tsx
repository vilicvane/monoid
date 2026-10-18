import {css, styled} from 'styled-components';

import {InfoFieldset, InfoSection, InfoSectionHeader} from './info-section.js';
import {Tag, darkTagCSS} from './tag.js';

const messageBlockCSS = css`
  margin: 0 -2px;
  padding: 8px 10px;
  border-radius: var(--info-border-radius);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
`;

export const MessageContent = styled.pre`
  ${messageBlockCSS}
  background: var(--ion-color-light);
  font-family:
    ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
`;

export const InfoMessage = styled(InfoSection).attrs({role: 'status'})`
  ${messageBlockCSS}
  background: var(--color-message-background, var(--ion-color-light));
  color: var(--color-text-secondary);
  font-size: 14px;

  ${InfoFieldset} + & {
    margin-top: 0;
  }
`;

export const ErrorMessage = styled(InfoSection).attrs({role: 'status'})`
  ${messageBlockCSS}
  background: var(--ion-color-danger);
  color: var(--ion-color-danger-contrast);
  font-size: 14px;
`;

export const WarningMessage = styled(ErrorMessage)`
  background: var(--ion-color-warning);
  color: var(--ion-color-warning-contrast);
`;

export const MessageSectionTitle = styled(Tag)<{$emphasized?: boolean}>`
  align-self: flex-start;
  max-width: 100%;
  height: auto;
  min-height: 22px;
  background-color: transparent;
  line-height: 20px;
  overflow-wrap: anywhere;
  ${({$emphasized}) => $emphasized && darkTagCSS}
`;

export const MessageSectionHeader = styled(InfoSectionHeader)`
  > button:last-child {
    margin: 0;
  }
`;

export const MessageSectionTags = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;
  isolation: isolate;

  > ${MessageSectionTitle} {
    max-width: none;
  }

  > ${MessageSectionTitle}:first-child:not(:last-child) {
    z-index: 1;
    margin-right: calc(-1 * var(--tag-overlap) - var(--tag-inline-margin));
    background-color: white;
  }
`;
