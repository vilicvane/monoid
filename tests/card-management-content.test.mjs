import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

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
  ['@ui/step', ['OperationSteps', 'Step']],
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
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    APPLET_NAMES: {otp: 'Monoid OTP Applet'},
    getAppletCatalog: () => [{stage: 'otp', instanceAid: 'F06D6F6E6F69640501'}],
  },
});
const {CardMaintenanceContent} = await import(
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
  archive: {items: [{index: 'f2010000000000000001', alias: 'Example OTP'}]},
};

for (const [mode, title] of [
  ['update', 'Update applets'],
  ['reinstall', 'Reinstall applets'],
  ['fresh', 'Fresh install'],
]) {
  for (const phase of ['ready', 'replacing', 'restore', 'manual-restore']) {
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
        assert.equal(step(2).summary, 'Complete');
        assert.equal(step(2).activeNumero, active);
        assert.equal(step(2).processing, processing && active === 2);
        assert.equal(step(3).title, 'Restore');
        assert.equal(step(3).activeNumero, active);
        assert.equal(step(3).processing, processing && active === 3);
      }
    });
  }
}

test('manual recovery without an archive explains its source inside Restore', () => {
  const tree = CardMaintenanceContent({
    operation: {...operation, phase: 'manual-restore', archive: undefined},
    processing: false,
  });
  assert.equal(
    find(tree, node => node.type === 'Step' && node.props.numero === 1).props
      .summary,
    'From another bundle card',
  );
  assert.match(
    text(find(tree, node => node.type === 'Step' && node.props.numero === 3)),
    /Restore your items from another bundle card/,
  );
});

test('restore results and dropped access stay within the expanded Restore step after completion', () => {
  for (const complete of [false, true]) {
    const report = {
      complete,
      issues: [
        {index: operation.archive.items[0].index, reason: 'INVALID_PARAMETER'},
      ],
      droppedGrants: ['f06d6f6e6f69640501', 'unknown-aid'],
    };
    const tree = CardMaintenanceContent({operation, processing: false, report});
    const restore = find(
      tree,
      node => node.type === 'Step' && node.props.numero === 3,
    );
    assert.equal(restore.props.activeNumero, complete ? 4 : 3);
    assert.equal(restore.props.keepExpanded, true);
    const issues = find(restore, node => node.type === CardResourceIssues);
    assert.equal(issues.props.issues, report.issues);
    assert.equal(issues.props.items, operation.archive.items);
    assert.equal(
      text(find(restore, node => node.type === 'WarningMessage')),
      'Access not restored for Monoid OTP Applet, unknown-aid',
    );
  }
});

test('skipped resources group by readable reason and retain alias, type and index', () => {
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
      text(find(group, node => node.type === 'ListSectionTitle')),
    ),
    [
      'Not accepted by this card (1)',
      'Different item already on card (1)',
      'Unreadable record (1)',
      'Missing on card (1)',
      'Not supported by this card (2)',
      'Other (1)',
    ],
  );
  const first = find(groups[0], node => node.type === 'CardResourceItem');
  assert.deepEqual(first.props.data, {
    index: issues[0].index,
    alias: 'Example OTP',
    type: 0xf201,
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
