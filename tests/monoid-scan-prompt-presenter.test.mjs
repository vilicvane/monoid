import assert from 'node:assert/strict';
import {test} from 'node:test';

const {MonoidScanPromptPresenter} = await import(
  '../.bld/app/@services/monoid-scan-prompt-presenter.js'
);

function show(presenter, owner, content = 'Present a card') {
  presenter.show(owner, {scanning: false, content, onDismiss() {}});
  return presenter.current;
}

async function assertPending(promise) {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
}

test('hiding without a presentation completes immediately', async () => {
  const presenter = new MonoidScanPromptPresenter();

  assert.equal(await presenter.hide(Symbol()), true);
  assert.equal(presenter.current, undefined);
});

test('hide waits for the host to finish exiting and repeated callers share completion', async () => {
  const presenter = new MonoidScanPromptPresenter();
  const owner = Symbol();
  show(presenter, owner);

  const completion = presenter.hide(owner);
  const closing = presenter.current;
  assert.equal(closing.closing, true);
  assert.equal(presenter.hide(owner), completion);
  await assertPending(completion);

  presenter.remove(closing, true);

  assert.equal(await completion, true);
  assert.equal(presenter.current, undefined);
  assert.equal(await presenter.hide(owner), true);
});

test('content updates keep the same presentation and its exit callback remains valid', async () => {
  const presenter = new MonoidScanPromptPresenter();
  const owner = Symbol();
  const initial = show(presenter, owner);
  const updated = show(presenter, owner, 'Reading the card');

  assert.equal(updated.token, initial.token);
  assert.equal(updated.content, 'Reading the card');
  const completion = presenter.hide(owner);
  await assertPending(completion);

  presenter.remove(initial, true);

  assert.equal(await completion, true);
  assert.equal(presenter.current, undefined);
});

test('reopening cancels the prior exit and ignores its late success or failure', async () => {
  const presenter = new MonoidScanPromptPresenter();
  const owner = Symbol();
  const initial = show(presenter, owner);
  const firstExit = presenter.hide(owner);

  const reopened = show(presenter, owner, 'Present the card again');

  assert.equal(await firstExit, false);
  assert.notEqual(reopened.token, initial.token);
  const secondExit = presenter.hide(owner);
  presenter.remove(initial, true);
  presenter.remove(initial, false);

  assert.equal(presenter.current.token, reopened.token);
  await assertPending(secondExit);
  presenter.remove(reopened, true);
  assert.equal(await secondExit, true);
});

test('replacement cancels the old owner without allowing it to close the new presentation', async () => {
  const presenter = new MonoidScanPromptPresenter();
  const firstOwner = Symbol();
  const secondOwner = Symbol();
  const initial = show(presenter, firstOwner);
  const firstExit = presenter.hide(firstOwner);

  const replacement = show(presenter, secondOwner);

  assert.equal(await firstExit, false);
  assert.equal(await presenter.hide(firstOwner), false);
  presenter.remove(initial, true);
  assert.equal(presenter.current, replacement);
  assert.equal(replacement.closing, false);

  const secondExit = presenter.hide(secondOwner);
  await assertPending(secondExit);
  presenter.remove(replacement, true);
  assert.equal(await secondExit, true);
});

test('an animation failure resolves pending and later hide calls as unsuccessful', async () => {
  const presenter = new MonoidScanPromptPresenter();
  const owner = Symbol();
  const shown = show(presenter, owner);
  const completion = presenter.hide(owner);

  presenter.remove(shown, false);

  assert.equal(await completion, false);
  assert.equal(presenter.current, undefined);
  assert.equal(await presenter.hide(owner), false);
});

test('host teardown before hide retains a failed completion instead of permitting a save', async () => {
  const presenter = new MonoidScanPromptPresenter();
  const owner = Symbol();
  const shown = show(presenter, owner);

  presenter.remove(shown, false);

  assert.equal(await presenter.hide(owner), false);
});

test('removing a visible card is not a completed exit even if the callback reports success', async () => {
  const presenter = new MonoidScanPromptPresenter();
  const owner = Symbol();
  const shown = show(presenter, owner);

  presenter.remove(shown, true);

  assert.equal(await presenter.hide(owner), false);
});

test('showing after a completed removal starts a new completion', async () => {
  const presenter = new MonoidScanPromptPresenter();
  const owner = Symbol();
  const first = show(presenter, owner);
  const firstExit = presenter.hide(owner);
  presenter.remove(first, true);
  assert.equal(await firstExit, true);

  const second = show(presenter, owner);
  const secondExit = presenter.hide(owner);
  assert.notEqual(second.token, first.token);
  assert.notEqual(secondExit, firstExit);
  presenter.remove(first, false);
  await assertPending(secondExit);

  presenter.remove(second, true);
  assert.equal(await secondExit, true);
});
