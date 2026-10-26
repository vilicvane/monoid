import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ServerStyleSheet} from 'styled-components';

import {Step, Steps} from '../.bld/app/@components/@ui/step.js';

function renderSteps(props) {
  const sheet = new ServerStyleSheet();
  try {
    const markup = renderToStaticMarkup(
      sheet.collectStyles(
        createElement(
          Steps,
          null,
          ...props.map((step, index) =>
            createElement(Step, {
              key: index,
              title: `Step ${index + 1}`,
              ...step,
            }),
          ),
        ),
      ),
    );
    return {markup, css: sheet.getStyleTags()};
  } finally {
    sheet.seal();
  }
}

for (const color of [undefined, 'primary', 'warning']) {
  test(`active step uses ${color ?? 'default primary'} background and contrast`, () => {
    const {markup, css} = renderSteps([{numero: 2, activeNumero: 2, color}]);
    const palette = color ?? 'primary';
    assert.match(markup, /class="[^"]* active"/);
    assert.match(markup, />2<\/div>/);
    assert.ok(css.includes(`--indicator-color:var(--ion-color-${palette});`));
    assert.ok(
      css.includes(
        `.active{--indicator-contrast:var(--ion-color-${palette}-contrast);}`,
      ),
    );
    assert.ok(css.includes('color:var(--indicator-contrast);'));
    assert.doesNotMatch(markup, /\$color=| color=/);
  });
}

test('the connecting gradient follows the active step even when the done step has another color', () => {
  for (const [doneColor, activeColor] of [
    ['primary', 'warning'],
    ['warning', 'primary'],
  ]) {
    const {markup, css} = renderSteps([
      {numero: 1, activeNumero: 2, color: doneColor},
      {numero: 2, activeNumero: 2, color: activeColor},
    ]);
    const activeClass = markup.match(/class="[^" ]+ ([^" ]+) active"/)[1];
    assert.ok(
      css
        .replace(/\s/g, '')
        .includes(
          `.done:has(+.${activeClass}.active)::after{background-image:linear-gradient(tobottom,var(--ion-color-safe),var(--ion-color-${activeColor}));}`,
        ),
    );
  }
});

test('warning preserves done and pending colors and only expands active content', () => {
  const {markup, css} = renderSteps(
    [1, 2, 3].map(numero => ({
      numero,
      activeNumero: 2,
      color: 'warning',
      summary: `Summary ${numero}`,
      children: `Content ${numero}`,
    })),
  );
  assert.ok(
    css.includes('--indicator-contrast:var(--ion-color-primary-contrast);'),
  );
  assert.ok(
    css.includes(
      '.done{--indicator-color:var(--ion-color-safe);--indicator-line-color:var(--ion-color-safe);}',
    ),
  );
  assert.ok(
    css.includes('.pending{--indicator-color:var(--ion-color-light-shade);}'),
  );
  assert.match(markup, /Summary 1/);
  assert.match(markup, /Content 2/);
  assert.doesNotMatch(markup, /Summary [23]|Content [13]/);
});
