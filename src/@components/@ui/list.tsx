import {css, styled} from 'styled-components';

export const List = styled.div`
  flex: 1;
  margin: 0 calc(-1 * var(--list-item-padding-inline, var(--view-padding)));
`;

const listItemCSS = css`
  position: relative;
  display: flex;

  align-items: flex-start;
  justify-content: space-between;
  gap: var(--list-item-gap, 8px);

  padding: var(--list-item-padding-block, 8px)
    var(--list-item-padding-inline, var(--view-padding));

  overflow: hidden;
`;

export const ListItem = styled.div`
  ${listItemCSS}
`;

export const ListItemButton = styled.button`
  ${listItemCSS}
  align-items: center;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--ion-color-dark);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:disabled {
    cursor: default;
  }

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: -2px;
  }
`;

export const ListItemContent = styled.div`
  flex: 1;
  min-width: 0;
  align-self: center;

  display: flex;
  flex-direction: column;
  gap: var(--list-item-content-gap, 8px);
`;

export const ListItemName = styled.span`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 16px;
  line-height: var(--list-item-name-line-height, 22px);
`;

export const ListItemDescription = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 18px;
`;

export const ListSectionTitle = styled.h2`
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 14px;
  font-weight: normal;
  line-height: 20px;
`;
