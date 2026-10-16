import {styled} from 'styled-components';

import {Tag} from './tag.js';

export const MessageContent = styled.pre`
  margin: 0 -2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--ion-color-light);
  font-family:
    ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
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
