import type {CardInformation} from '../../../@lib/global-platform/card-information.js';
import type {MonoidAppletInstallation} from '../../../@lib/monoid/index.js';

export type CardAppletSnapshot = {
  information?: CardInformation;
  installation?: MonoidAppletInstallation;
  unsupported?: boolean;
};
