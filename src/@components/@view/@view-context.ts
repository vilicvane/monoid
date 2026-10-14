import {createContext} from 'react';

export const ViewContext = createContext<{
  scrolled: boolean;
  canScrollDown: boolean;
}>(undefined!);
