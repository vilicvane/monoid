import {css, styled} from 'styled-components';

import {CenteredPopup} from './centered-popup.js';
import {InfoSectionDivider} from './info-section.js';

export const DetailsPopup = styled(CenteredPopup)`
  --details-popup-gap: 16px;

  gap: var(--details-popup-gap);
`;

export const DetailsPopupHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
`;

export const DetailsPopupTitle = styled.h2`
  min-width: 0;
  margin: 0;
  font-size: 18px;
  font-weight: 500;
  line-height: 1.4;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

/** A secondary line directly under the title, inside the header. */
export const DetailsPopupDescription = styled.p`
  min-width: 0;
  margin: calc(4px - var(--details-popup-gap)) 0 0;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 20px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const detailsPopupLogoCSS = css`
  flex-shrink: 0;
  width: 32px;
  height: 32px;
`;

export const DetailsPopupDivider = styled(InfoSectionDivider)`
  margin-bottom: calc(18px - var(--details-popup-gap));
`;

export const DetailsPopupSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--details-popup-gap);
  min-width: 0;
`;
