import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import type {CardInformation} from '../../../../@lib/global-platform/card-information.js';
import {Button} from '../../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../../@ui/details-popup.js';
import {InfoSection} from '../../../@ui/info-section.js';

import {CardInformationDetails} from './card-information-details.js';
import {CardSetupInformation} from './card-setup-information.js';

const Overview = styled(InfoSection)`
  --ion-color-light-shade: rgba(255, 255, 255, 0.45);
  --ion-color-dark: rgba(255, 255, 255, 0.12);
  --ion-color-dark-shade: rgba(255, 255, 255, 0.55);
  --ion-color-dark-contrast: white;
`;

export function CardInformationPopup({
  information,
  onDismiss,
}: {
  information: CardInformation;
  onDismiss: () => void;
}): ReactNode {
  const [details, setDetails] = useState(false);

  return (
    <DetailsPopup
      aria-label={details ? 'Card details' : 'Card information'}
      contentKey={details ? 'details' : 'overview'}
      initialFocus="dialog"
      onDismiss={() => (details ? setDetails(false) : onDismiss())}
    >
      <DetailsPopupTitle>
        {details ? 'Card details' : 'Card information'}
      </DetailsPopupTitle>
      {!details && <DetailsPopupDivider />}
      {details ? (
        <CardInformationDetails information={information} />
      ) : (
        <>
          <Overview>
            <CardSetupInformation information={information} />
          </Overview>
          <Button color="neutral" onClick={() => setDetails(true)}>
            Details
          </Button>
        </>
      )}
    </DetailsPopup>
  );
}
