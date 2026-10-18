import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

mock.module('../.bld/app/@lib/render-icon.js', {
  namedExports: {renderIcon: () => 'icon'},
});
mock.module('../.bld/app/@services/monoid-credentials-store.js', {
  namedExports: {
    isCredentialRequestCancelled: error => error?.code === 'CANCELLED',
  },
});

const {ErrorService} = await import('../.bld/app/@services/error-service.js');

function fixture(t) {
  const service = new ErrorService();
  const toasts = [];
  service.presentToast = async options => toasts.push(options);
  const log = t.mock.method(console, 'error', () => {});
  return {service, toasts, log};
}

test('an error already shown inline is logged without a duplicate toast', async t => {
  const {service, toasts, log} = fixture(t);
  const error = new Error('Wrong card');

  assert.equal(service.markPresented(error), error);
  service.catch(Promise.reject(error));
  service.catch(async () => {
    throw error;
  })();
  await setImmediate();

  assert.equal(toasts.length, 0);
  assert.equal(
    log.mock.calls.filter(call => call.arguments[0] === error).length,
    2,
  );
});

test('another error with the same message still gets a toast', async t => {
  const {service, toasts} = fixture(t);
  service.markPresented(new Error('Could not read card'));
  service.catch(Promise.reject(new Error('Could not read card')));
  await setImmediate();

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Could not read card');
});

test('non-Error failures can be marked without suppressing unrelated failures', async t => {
  const {service, toasts} = fixture(t);
  const presented = service.markPresented('Card failure');
  service.catch(Promise.reject(presented));
  service.catch(Promise.reject('Card failure'));
  await setImmediate();

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Card failure');
});

test('cancellation remains silent', async t => {
  const {service, toasts, log} = fixture(t);
  service.catch(Promise.reject({code: 'CANCELLED'}));
  await setImmediate();

  assert.equal(toasts.length, 0);
  assert.equal(log.mock.callCount(), 0);
});
