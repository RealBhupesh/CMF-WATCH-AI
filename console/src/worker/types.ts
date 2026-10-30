import type { Env } from './env';
import type { DeviceRow } from './db/queries';

export interface Variables {
  requestId: string;
  device?: DeviceRow;
  ownerEmail?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
