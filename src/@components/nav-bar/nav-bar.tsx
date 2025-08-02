import classNames from 'classNames';
import {observer} from 'mobx-react-lite';
import {type ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';

import {Tabs as Tabs_} from './@tabs.js';

const Container = styled.div`
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;

  border-top: solid 0.5px #eee;
  background-color: rgba(245, 245, 245, 0.8);
  backdrop-filter: blur(4px);

  display: flex;

  z-index: 2;
`;

const Tabs = styled(Tabs_)`
  flex: 1;

  transition: padding-right 0.2s ease-out;

  ${Container}.fab-active & {
    padding-right: 25%;
  }
`;

export const NavBar = observer((): ReactNode => {
  const {portalsService} = useEntrances();

  return (
    <Container
      id="nav-bar"
      className={classNames({
        'fab-active': portalsService.fabActive,
      })}
    >
      <Tabs />
    </Container>
  );
});
