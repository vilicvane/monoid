import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {cardName, cardNameWithId} from '../.bld/app/@lib/monoid/card-name.js';

mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});
mock.module('styled-components', {
  namedExports: {
    styled: new Proxy(component => () => component, {
      get: (_target, tag) => () => `styled-${tag}`,
    }),
  },
});
for (const [path, names] of [
  ['@ui/app-icon', ['AppIcon']],
  ['@ui/feature-icons', ['AppletIcon']],
  ['@ui/info-section', ['InfoSection']],
  [
    '@ui/list',
    [
      'IconList',
      'ListItem',
      'ListItemButton',
      'ListItemContent',
      'ListItemDescription',
      'ListItemName',
      'ListSectionTitle',
    ],
  ],
  ['@ui/message-content', ['InfoMessage', 'WarningMessage']],
  ['@ui/step', ['Steps', 'Step']],
  [
    '@monoid/card-preview',
    ['CardGrid', 'CardPlaceholder', 'CardPreview', 'CardPreviewButton'],
  ],
  ['views/safe/@card/@resource-item', ['CardResourceList', 'CardResourceItem']],
]) {
  mock.module(`../.bld/app/@components/${path}.js`, {
    namedExports: {
      ...Object.fromEntries(names.map(name => [name, name])),
      ...(path === '@ui/list' && {LIST_ICON_SIZE: 36}),
    },
  });
}
const {CardResourceIssues} = await import(
  '../.bld/app/@components/views/safe/@card/card-resource-issues.js'
);
mock.module('../.bld/app/@components/views/safe/index.js', {
  namedExports: {
    CardSetupInformation: 'CardSetupInformation',
    CardResourceIssues,
  },
});
const {APPLET_NAMES, APPLET_SHORT_NAMES} = await import(
  '../.bld/app/@lib/monoid/applet-install-progress.js'
);
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    APPLET_NAMES,
    APPLET_SHORT_NAMES,
    cardName,
    cardNameWithId,
    getAppletCatalog: () => [{stage: 'otp', instanceAid: 'F06D6F6E6F69640501'}],
  },
});
const {
  CardAppletsContent,
  CardMaintenanceBatchContent,
  CardMaintenanceCards,
  CardMaintenanceContent,
  CardSupersededMaintenanceNotice,
} = await import(
  '../.bld/app/@components/views/card/card-management-content.js'
);

function find(node, predicate) {
  if (node === undefined || node === null) return;
  if (predicate(node)) return node;
  for (const child of Array.isArray(node) ? node : [node.props?.children]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  return (Array.isArray(node) ? node : [node.props?.children])
    .map(text)
    .join('');
}

const operation = {
  mode: 'update',
  phase: 'ready',
  card: {id: '01020304', bundle: false},
  replaceStages: ['library', 'monoid'],
  selectedOptionalStages: ['security-key', 'otp'],
  archive: {items: [{index: 'f2010000000000000001', alias: 'Example OTP'}]},
};

test('superseded maintenance is a plain warning notice with the old card name and unrestored item count', () => {
  for (const alias of [false, 'Travel']) {
    for (const count of [undefined, 0, 1, 2]) {
      const tree = CardSupersededMaintenanceNotice({
        operation: {
          ...operation,
          card: {...operation.card, id: 'd33490cd', alias},
          archive:
            count === undefined ? undefined : {items: Array(count).fill({})},
        },
      });
      assert.equal(tree.type, 'WarningMessage');
      assert.equal(
        text(tree),
        `This card still holds unfinished maintenance of card ${alias || 'd33490cd'} from before it was set up again. ${count === undefined ? '' : `${count} ${count === 1 ? 'item was' : 'items were'} never restored. `}Discard it from the menu.`,
      );
    }
  }
});

test('maintenance and catalogue heroes carry the alias, and batch cards retain their status', () => {
  const card = {...operation.card, alias: '旅行卡', bundle: 'bundle'};
  for (const tree of [
    CardMaintenanceContent({
      operation: {...operation, card},
      processing: false,
    }),
    CardAppletsContent({
      ...card,
      bundled: true,
      applets: [],
      onSelectApplet() {},
    }),
  ]) {
    const hero = find(tree, node => typeof node.type === 'function');
    const preview = find(
      hero.type(hero.props),
      node => node.type === 'CardPreview',
    );
    assert.equal(preview.props.alias, card.alias);
    assert.equal(preview.props.subtitle, 'bundle');
  }
  const grid = CardMaintenanceCards({
    cards: [
      {
        ...card,
        publicKey: 'key',
        complete: false,
        scan: 'next',
        status: 'scan to install',
      },
    ],
  });
  const preview = find(grid, node => node.type === 'CardPreview');
  assert.equal(preview.props.alias, card.alias);
  assert.equal(preview.props.description, 'scan to install');
});

for (const [mode, title, hint] of [
  ['update', 'Update applets', 'Scan card 01020304 to update its applets.'],
  [
    'reinstall',
    'Reinstall applets',
    'Scan card 01020304 to reinstall its applets.',
  ],
  ['fresh', 'Fresh install', 'Scan card 01020304 to install fresh applets.'],
]) {
  for (const phase of ['ready', 'replacing', 'restore']) {
    test(`${mode} in ${phase} shows the correct active step and scan indicator`, () => {
      for (const processing of [false, true]) {
        const tree = CardMaintenanceContent({
          operation: {...operation, mode, phase},
          processing,
        });
        const step = numero =>
          find(
            tree,
            node => node.type === 'Step' && node.props.numero === numero,
          ).props;
        const active = ['ready', 'replacing'].includes(phase) ? 2 : 3;
        assert.equal(step(1).title, 'Save recovery');
        assert.equal(step(1).summary, '1 item');
        assert.equal(step(1).activeNumero, active);
        assert.equal(step(2).title, title);
        assert.equal(step(2).summary, 'Monoid · Security Key · OTP');
        assert.equal(step(2).activeNumero, active);
        assert.equal(step(2).processing, processing && active === 2);
        assert.equal(step(3).title, 'Restore');
        assert.equal(step(3).activeNumero, active);
        assert.equal(step(3).processing, processing && active === 3);
        for (const numero of [1, 2, 3]) {
          assert.equal(step(numero).color, 'warning');
          assert.equal(
            text(
              find(step(numero).children, node => node.type === 'InfoMessage'),
            ),
            numero !== active
              ? ''
              : active === 2
                ? hint
                : 'Scan card 01020304 to restore its 1 item and applet access.',
          );
        }
      }
    });
  }
}

test('maintenance scan hints name the saved alias and retain the ID when known', () => {
  for (const [card, instruction] of [
    [{id: '01020304', alias: 'Travel'}, 'Scan card Travel (01020304)'],
    [{}, 'Scan this card'],
  ]) {
    for (const [phase, action] of [
      ['ready', 'to update its applets.'],
      ['restore', 'to restore its 1 item and applet access.'],
    ]) {
      const tree = CardMaintenanceContent({
        operation: {...operation, card, phase},
        processing: false,
      });
      assert.equal(
        text(find(tree, node => node.type === 'InfoMessage')),
        `${instruction} ${action}`,
      );
    }
  }
});

test('steps use primary without a recovery archive', () => {
  for (const phase of ['ready', 'replacing', 'restore']) {
    const tree = CardMaintenanceContent({
      operation: {...operation, phase, archive: undefined},
      processing: false,
    });
    for (const numero of [1, 2, 3]) {
      assert.equal(
        find(tree, node => node.type === 'Step' && node.props.numero === numero)
          .props.color,
        'primary',
      );
    }
  }
});

test('restore hint counts the archived items before the first pass', () => {
  for (const count of [0, 1, 8]) {
    const tree = CardMaintenanceContent({
      operation: {
        ...operation,
        phase: 'restore',
        archive: {items: Array(count).fill(operation.archive.items[0])},
      },
      processing: false,
    });
    assert.equal(
      text(find(tree, node => node.type === 'InfoMessage')),
      `Scan card 01020304 to restore its ${count} ${count === 1 ? 'item' : 'items'} and applet access.`,
    );
  }
});

test('applet summaries use short names once, in stage order, and omit the library', () => {
  for (const [replaceStages, selectedOptionalStages, summary] of [
    [['monoid', 'otp'], ['otp', 'security-key'], 'Monoid · OTP · Security Key'],
    [['identity', 'library', 'monoid'], ['otp'], 'Identity · Monoid · OTP'],
    [['library', 'monoid'], undefined, 'Monoid'],
    [undefined, ['library', 'otp'], 'OTP'],
    [['library'], [], 'Complete'],
    [['unnamed', 'monoid'], undefined, 'Monoid'],
    [['unnamed'], [], 'Complete'],
    [[], [], 'Complete'],
    [undefined, undefined, 'Complete'],
  ]) {
    const tree = CardMaintenanceContent({
      operation: {...operation, replaceStages, selectedOptionalStages},
      processing: false,
    });
    assert.equal(
      find(tree, node => node.type === 'Step' && node.props.numero === 2).props
        .summary,
      summary,
    );
  }
});

test('completed maintenance marks all steps done while the parent animates the process out', () => {
  const tree = CardMaintenanceContent({
    operation,
    processing: false,
    complete: true,
  });
  assert.ok(find(tree, node => node.type === 'Steps'));
  for (const numero of [1, 2, 3]) {
    assert.equal(
      find(tree, node => node.type === 'Step' && node.props.numero === numero)
        .props.activeNumero,
      4,
    );
  }
  assert.equal(
    find(tree, node => node.type === 'InfoMessage'),
    undefined,
  );
});

test('restore results replace hints and remain available during the completion exit', () => {
  for (const [phase, complete] of [
    ['restore', false],
    ['restore', true],
  ]) {
    const report = {
      complete,
      issues: [
        {index: operation.archive.items[0].index, reason: 'INVALID_PARAMETER'},
      ],
      droppedGrants: ['f06d6f6e6f69640501', 'unknown-aid'],
    };
    const tree = CardMaintenanceContent({
      operation: {...operation, phase},
      processing: false,
      report,
    });
    const restore = find(
      tree,
      node => node.type === 'Step' && node.props.numero === 3,
    );
    assert.equal(restore.props.activeNumero, complete ? 4 : 3);
    assert.equal(restore.props.keepExpanded, true);
    assert.equal(restore.props.color, 'warning');
    assert.equal(
      find(tree, node => node.type === 'InfoMessage'),
      undefined,
    );
    const shown = renderReport(restore);
    assert.equal(shown.issues.props.issues, report.issues);
    assert.equal(shown.issues.props.items, operation.archive.items);
    assert.equal(
      shown.access,
      'Access not restored for Monoid OTP Applet, unknown-aid',
    );
  }
});

/** Renders the restore report component found under a step. */
function renderReport(step) {
  const node = find(step, node => node.type?.name === 'RestoreReport');
  const tree = node.type(node.props);
  return {
    issues: find(tree, node => node.type === CardResourceIssues),
    access: text(find(tree, node => node.type === 'WarningMessage')),
  };
}

test('a batch shows saved recoveries, then its card grid in one active step', () => {
  const cards = [
    {
      publicKey: 'a',
      id: '00000001',
      complete: false,
      scan: 'next',
      status: 'scan to install',
    },
    {
      publicKey: 'b',
      id: '00000002',
      complete: false,
      scan: 'pending',
      status: 'install later',
    },
  ];
  const tree = CardMaintenanceBatchContent({
    mode: 'update',
    cards,
    complete: false,
    processing: true,
  });
  const [recovery, replacement] = [1, 2].map(numero =>
    find(tree, node => node.type === 'Step' && node.props.numero === numero),
  );
  assert.equal(recovery.props.summary, '2 cards');
  assert.equal(replacement.props.title, 'Update applets');
  assert.equal(replacement.props.activeNumero, 2);
  assert.equal(replacement.props.processing, true);
  assert.equal(replacement.props.color, 'warning');
  assert.equal(
    find(replacement, node => node.type === CardMaintenanceCards).props.cards,
    cards,
  );
  assert.match(
    text(find(replacement, node => node.type === 'InfoMessage')),
    /updated and restored before the next one/,
  );

  const report = {
    complete: false,
    issues: [{index: 'f201000000000000000a', reason: 'INVALID_PARAMETER'}],
    droppedGrants: [],
  };
  const reported = CardMaintenanceBatchContent({
    mode: 'reinstall',
    cards,
    complete: true,
    processing: false,
    report,
    items: [],
  });
  const step = find(
    reported,
    node => node.type === 'Step' && node.props.numero === 2,
  );
  assert.equal(step.props.title, 'Reinstall applets');
  assert.equal(step.props.activeNumero, 3);
  assert.equal(
    find(step, node => node.type === 'InfoMessage'),
    undefined,
  );
  assert.equal(renderReport(step).issues.props.issues, report.issues);
});

test('skipped resources group by readable reason and pass aliases and indices to resource items', () => {
  const reasons = [
    'INVALID_PARAMETER',
    'Conflict',
    'Unreadable',
    'NOT_FOUND',
    'UNSUPPORTED_CURVE',
    'UNSUPPORTED_SEED_LENGTH',
    'Other',
  ];
  const issues = reasons.map((reason, index) => ({
    index: `f201000000000000000${index}`,
    reason,
  }));
  const groups = CardResourceIssues({
    issues,
    items: [{index: issues[0].index, alias: 'Example OTP'}],
  });
  assert.deepEqual(
    groups.map(group =>
      text(find(group, node => node.props?.role === 'separator')),
    ),
    [
      'Not accepted by this card',
      'Different item already on card',
      'Unreadable record',
      'Missing on card',
      'Not supported by this card',
      'Other',
    ],
  );
  const first = find(groups[0], node => node.type === 'CardResourceItem');
  assert.deepEqual(first.props.data, {
    index: issues[0].index,
    alias: 'Example OTP',
  });
  assert.equal(
    find(groups[1], node => node.type === 'CardResourceItem').props.data.alias,
    undefined,
  );
  for (const group of groups)
    assert.equal(
      find(group, node => node.type === 'CardResourceList').props.$contained,
      true,
    );
  assert.deepEqual(CardResourceIssues({issues: []}), []);
});
