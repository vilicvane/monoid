import type {UseIonAlertResult, UseIonToastResult} from '@ionic/react';
import {Bug as bug} from 'lucide-react';

import {isOperationCancelled} from '../@lib/operation-cancelled.js';
import {renderIcon} from '../@lib/render-icon.js';

const ERROR_TOAST_DURATION = 5000;

export class ErrorService {
  presentToast: UseIonToastResult[0] | undefined;
  presentAlert: UseIonAlertResult[0] | undefined;

  private readonly presentedErrors = new WeakSet<object>();

  markPresented(error: unknown): unknown {
    const presented =
      typeof error === 'object' && error !== null
        ? error
        : new Error(String(error));

    this.presentedErrors.add(presented);
    return presented;
  }

  catch(promise: Promise<void>, message?: string): void;
  catch<TArgs extends unknown[]>(
    callback: (...args: TArgs) => Promise<void> | void,
    message?: string,
  ): (...args: TArgs) => void;
  catch(
    promiseOrCallback:
      | ((...args: unknown[]) => Promise<void> | void)
      | Promise<void>,
    message?: string,
  ): ((...args: unknown[]) => void) | void {
    if (promiseOrCallback instanceof Promise) {
      promiseOrCallback.catch(error => this.handleError(error, message));
    } else {
      return (...args: unknown[]): void => {
        (async () => {
          await promiseOrCallback(...args);
        })().catch(error => this.handleError(error, message));
      };
    }
  }

  private handleError(error: unknown, message?: string): void {
    if (isOperationCancelled(error)) {
      return;
    }

    console.error(error);

    if (
      typeof error === 'object' &&
      error !== null &&
      this.presentedErrors.has(error)
    ) {
      return;
    }

    void this.presentToast?.({
      cssClass: 'error-toast',
      icon: renderIcon(bug),
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
            });
          },
        },
      ],
    });
  }
}
