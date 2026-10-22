import type { ReactNode } from 'react';
import type { AppCommand, AppSnapshot, CommandResult } from '../shared/types';
export type Page = 'browsers' | 'links' | 'proxies' | 'settings';
export interface Actions {
  run: (command: AppCommand, success?: string) => Promise<CommandResult | undefined>;
  confirm: (title: string, message: string, action: () => void, destructive?: boolean) => void;
  inspect: (title: string, content: ReactNode) => void;
  setPage: (page: Page) => void;
}
export interface PageProps extends Actions {
  snapshot: AppSnapshot;
  selected: number[];
  setSelected: (ids: number[]) => void;
  busy: boolean;
}
