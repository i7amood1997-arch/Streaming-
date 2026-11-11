import { createClient } from 'redis';

export interface RedisHandle {
  client: ReturnType<typeof createClient>;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Connects in the background with exponential reconnects, so the API can
 * start (and report not-ready) while Redis is down. Commands fail fast
 * instead of queueing while disconnected.
 */
export function createRedis(url: string, onError: (err: Error) => void): RedisHandle {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 10_000),
    },
  });
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
