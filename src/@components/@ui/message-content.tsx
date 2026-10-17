import {css, styled} from 'styled-components';

import {InfoSection} from './info-section.js';
import {Tag} from './tag.js';

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

export const ErrorMessage = styled(InfoSection).attrs({role: 'status'})`
  ${messageBlockCSS}
  background: var(--ion-color-danger);
  color: var(--ion-color-danger-contrast);
  font-size: 14px;
`;

export const MessageSectionTitle = styled(Tag)`
  align-self: flex-start;
  max-width: 100%;
  height: auto;
  min-height: 22px;
  background-color: transparent;
  line-height: 20px;
  overflow-wrap: anywhere;
`;
