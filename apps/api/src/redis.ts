import { createClient } from 'redis';

function connectClient(url: string) {
  return createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 10_000),
    },
  });
}

/** Concrete client type for our options (RESP3, default modules). */
export type RedisClient = ReturnType<typeof connectClient>;

export interface RedisHandle {
  client: RedisClient;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Connects in the background with exponential reconnects, so the API can
 * start (and report not-ready) while Redis is down. Commands fail fast
 * instead of queueing while disconnected.
 */
export function createRedis(url: string, onError: (err: Error) => void): RedisHandle {
  const client = connectClient(url);
  client.on('error', onError);
  client.connect().catch(onError);
  return {
    client,
    ping: async () => {
      if (!client.isReady) throw new Error('not connected');
      await client.ping();
    },
    close: async () => {
      if (client.isOpen) {
        await client.close();
        return;
      }
      try {
        client.destroy(); // stops pending reconnect attempts
      } catch {
        /* already closed */
      }
    },
  };
}
