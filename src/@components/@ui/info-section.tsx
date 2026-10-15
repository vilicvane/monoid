import {styled} from 'styled-components';

export const InfoSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;

  & + & {
    margin-top: 16px;
  }
`;

export const InfoSectionTitle = styled.div``;

export const InfoSectionItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const InfoSectionItemLabel = styled.div`
  font-size: 14px;
  color: var(--ion-color-medium);
`;

export const InfoSectionItemContent = styled.div``;

export const InfoSectionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 16px;
  font-size: 14px;

  > :last-child {
    margin-left: auto;
    text-align: right;
  }
`;
