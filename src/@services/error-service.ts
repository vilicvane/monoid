import type {UseIonAlertResult, UseIonToastResult} from '@ionic/react';
import {bug} from 'ionicons/icons';

const ERROR_TOAST_DURATION = 5000;

export class ErrorService {
  presentToast: UseIonToastResult[0] | undefined;
  presentAlert: UseIonAlertResult[0] | undefined;

  catch<TArgs extends unknown[]>(
    callback: (...args: TArgs) => Promise<void> | void,
    message?: string,
  ): (...args: TArgs) => void {
    return (...args: TArgs): void => {
      (async () => {
        await callback(...args);
      })().catch(error => {
        console.error(error);

        void this.presentToast?.({
          icon: bug,
          header: message ?? 'An error occurred',
          message: error instanceof Error ? error.message : String(error),
          duration: ERROR_TOAST_DURATION,
          color: 'danger',
          position: 'top',
          layout: 'stacked',
          swipeGesture: 'vertical',
          buttons: [
            {
              text: 'Details',
              handler: () => {
                void this.presentAlert?.({
                  header: 'Error Details',
                  message: error instanceof Error ? error.stack : String(error),
                  buttons: ['Close'],
                });
              },
            },
            {
              text: 'Dismiss',
              role: 'cancel',
            },
          ],
        });
      });
    };
  }
}
