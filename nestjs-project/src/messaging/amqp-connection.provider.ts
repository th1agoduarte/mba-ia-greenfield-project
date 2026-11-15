import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { connect } from 'amqp-connection-manager';
import messagingConfig from '../config/messaging.config';
import { AMQP_CONNECTION } from './messaging.constants';

/** One resilient connection per process; reconnects automatically. */
export const amqpConnectionProvider: Provider = {
  provide: AMQP_CONNECTION,
  inject: [messagingConfig.KEY],
  useFactory: (config: ConfigType<typeof messagingConfig>) =>
    connect([config.url]),
};
