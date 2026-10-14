import classNames from 'classNames';
import globe from 'lucide-static/icons/globe.svg';
import lockKeyhole from 'lucide-static/icons/lock-keyhole.svg';
import scan from 'lucide-static/icons/scan.svg';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

import {Tab as Tab_} from './@tab.js';

export const Container = styled.div`
  box-sizing: content-box;
  height: var(--nav-bar-height);
  padding: 0 20px var(--view-inset-bottom);

  display: flex;
  justify-content: space-around;

  overflow: hidden;
`;

const Tab = styled(Tab_)`
  height: var(--nav-bar-height);
  flex: 1;
`;

export const Tabs = ({className}: {className?: string}): ReactNode => {
  const {router} = useEntrances();

  return (
    <Container className={classNames(className)}>
      <Tab icon={globe} route={router.sessions} />
      <Tab icon={scan} route={router.scan} />
      <Tab icon={lockKeyhole} route={router.safe} />
    </Container>
  );
};
