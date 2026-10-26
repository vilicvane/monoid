import assert from 'node:assert/strict';
import {test} from 'node:test';

import {requestCardPINs} from '../.bld/app/@components/@monoid/request-card-pins.js';

const secret = 'Secret-42';
const access = 'Access-43';
const signal = () => new AbortController().signal;
function prompt(answers, options = {}) {
  const inputs = [];
  return {
    inputs,
    show: async input => {
      inputs.push(input);
      if (input.checkbox && options.different !== undefined)
        input.checkbox.onChange(options.different);
      assert.ok(answers.length, 'Unexpected extra PIN prompt');
      return answers.shift();
    },
  };
}

test('new setup confirms both PINs and defaults to separate Access PIN', async () => {
  const ui = prompt([secret, secret, access, access]);
  assert.deepEqual(
    await requestCardPINs(
      ui.show,
      {secretSet: false, accessSet: false, savedAccessPIN: 'old-pin'},
      signal(),
    ),
    {secret, access},
  );
  assert.equal(ui.inputs[0].checkbox.defaultChecked, true);
  assert.deepEqual(
    ui.inputs.map(i => i.placeholder),
    [
      'Set Secret PIN',
      'Confirm Secret PIN',
      'Set Access PIN',
      'Confirm Access PIN',
    ],
  );
  assert.ok(ui.inputs.slice(1).every(i => i.checkbox === undefined));
});

test('unchecked setup uses the twice-confirmed Secret PIN without another input', async () => {
  const ui = prompt([secret, secret], {different: false});
  assert.deepEqual(
    await requestCardPINs(
      ui.show,
      {secretSet: false, accessSet: false},
      signal(),
    ),
    {secret, access: secret},
  );
  assert.equal(ui.inputs.length, 2);
});

test('restore uses saved Access PIN and asks existing Secret PIN only once', async () => {
  const ui = prompt([secret]);
  assert.deepEqual(
    await requestCardPINs(
      ui.show,
      {secretSet: true, accessSet: false, savedAccessPIN: access},
      signal(),
    ),
    {secret, access},
  );
  assert.equal(ui.inputs[0].checkbox, undefined);
});

test('restore without saved Access PIN confirms the new Access PIN', async () => {
  const ui = prompt([secret, access, access]);
  assert.deepEqual(
    await requestCardPINs(
      ui.show,
      {secretSet: true, accessSet: false},
      signal(),
    ),
    {secret, access},
  );
  assert.deepEqual(
    ui.inputs.map(i => i.placeholder),
    ['Enter existing Secret PIN', 'Set Access PIN', 'Confirm Access PIN'],
  );
});

test('existing PINs require authentication only and never prepare replacement Access PIN', async () => {
  const ui = prompt([secret]);
  assert.deepEqual(
    await requestCardPINs(
      ui.show,
      {secretSet: true, accessSet: true, savedAccessPIN: access},
      signal(),
    ),
    {secret},
  );
});

for (const accessSet of [true, false]) {
  for (const savedAccessPIN of [undefined, access]) {
    test(`held Secret skips only its prompt (Access set ${accessSet}, saved ${!!savedAccessPIN})`, async () => {
      const needsAccess = !accessSet && !savedAccessPIN;
      const ui = prompt(needsAccess ? [access, access] : []);
      assert.deepEqual(
        await requestCardPINs(
          ui.show,
          {
            secretSet: true,
            accessSet,
            savedAccessPIN,
            heldSecretPIN: secret,
          },
          signal(),
        ),
        accessSet ? {secret} : {secret, access},
      );
      assert.deepEqual(
        ui.inputs.map(input => input.placeholder),
        needsAccess ? ['Set Access PIN', 'Confirm Access PIN'] : [],
      );
    });
  }
}

test('new Secret setup ignores a held PIN and still requires confirmation', async () => {
  const ui = prompt([secret, secret, access, access]);
  assert.deepEqual(
    await requestCardPINs(
      ui.show,
      {
        secretSet: false,
        accessSet: false,
        heldSecretPIN: 'Old-Secret',
      },
      signal(),
    ),
    {secret, access},
  );
  assert.equal(ui.inputs.length, 4);
});

test('an aborted request cannot return a held Secret PIN', async () => {
  const ui = prompt([]);
  await assert.rejects(
    requestCardPINs(
      ui.show,
      {
        secretSet: true,
        accessSet: true,
        heldSecretPIN: secret,
      },
      AbortSignal.abort(),
    ),
    {name: 'AbortError'},
  );
  assert.equal(ui.inputs.length, 0);
});

test('format and confirmation errors remain in the corresponding prompt', async () => {
  const ui = prompt([
    'short',
    secret,
    'mismatch',
    secret,
    access,
    'wrong',
    access,
  ]);
  assert.deepEqual(
    await requestCardPINs(
      ui.show,
      {secretSet: false, accessSet: false},
      signal(),
    ),
    {secret, access},
  );
  assert.match(ui.inputs[1].description, /6 to 16/);
  assert.equal(ui.inputs[3].description, 'PINs do not match');
  assert.equal(ui.inputs[6].description, 'PINs do not match');
});

for (let step = 0; step < 4; step++)
  test(`cancelling input ${step + 1} never returns partial credentials`, async () => {
    const ui = prompt([
      ...[secret, secret, access, access].slice(0, step),
      undefined,
    ]);
    assert.equal(
      await requestCardPINs(
        ui.show,
        {secretSet: false, accessSet: false},
        signal(),
      ),
      undefined,
    );
  });

test('leaving during a prompt cannot return credentials or start another prompt', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    requestCardPINs(
      async () => {
        calls++;
        controller.abort();
        return secret;
      },
      {secretSet: false, accessSet: false},
      controller.signal,
    ),
    {name: 'AbortError'},
  );
  assert.equal(calls, 1);
});
