import type { AddressInfo } from 'node:net';

import {
  createGatewayHttpRuntime,
  type GatewayHttpOptions,
  type GatewayHttpRuntime
} from './http.js';

export interface GatewayCliOptions extends GatewayHttpOptions {
  readonly host?: string;
  readonly port?: number;
  readonly installSignalHandlers?: boolean;
}

export interface RunningGateway {
  readonly runtime: GatewayHttpRuntime;
  readonly address: AddressInfo;
  close(): Promise<void>;
}

export async function runGateway(options: GatewayCliOptions): Promise<RunningGateway> {
  const runtime = createGatewayHttpRuntime(options);
  try {
    await runtime.listen(options.port ?? 8000, options.host ?? '0.0.0.0');
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
  const address = runtime.server.address();
  if (address === null || typeof address === 'string') {
    await runtime.close();
    throw new Error('Gateway did not bind a TCP address');
  }

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= runtime.close().finally(() => {
      for (const signal of signals) process.off(signal, onSignal);
    });
    return closePromise;
  };
  const onSignal = (): void => {
    void close().catch((error: unknown) => {
      options.onerror?.(error instanceof Error ? error : new Error(String(error)));
    });
  };
  if (options.installSignalHandlers !== false) {
    for (const signal of signals) process.once(signal, onSignal);
  }
  return { runtime, address, close };
}
