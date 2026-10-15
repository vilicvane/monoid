import {styled} from 'styled-components';

export const MessageContent = styled.pre`
  margin: 0 -2px;
  padding: 8px;
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
