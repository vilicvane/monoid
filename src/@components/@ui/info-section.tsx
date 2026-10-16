import {styled} from 'styled-components';

export const InfoSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;

  & + & {
    margin-top: calc(var(--view-section-gap, 16px) - 8px);
  }
`;

export const InfoSectionTitle = styled.div``;

export const InfoSectionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  > button:last-child {
    margin-right: -8px;
  }
`;

export const InfoSectionItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const InfoSectionItemLabel = styled.div`
  font-size: 14px;
  color: var(--color-text-label, var(--ion-color-medium));
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
