import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Catalog } from './catalog.js';
import type { Config } from './config.js';
import { buildServer } from './http/server.js';
import { SessionManager } from './session/session-manager.js';
import { TorrentEngine } from './torrent/engine.js';
import { TorrentSourceServer } from './torrent/source-server.js';

export interface App {
  server: FastifyInstance;
  manager: SessionManager;
  engine: TorrentEngine;
  close: () => Promise<void>;
}

/** Composition root shared by main.ts and the end-to-end tests. */
export async function createApp(
  config: Config,
  opts: { bootstrapPeers?: string[]; logger?: boolean } = {},
): Promise<App> {
  const catalog = await Catalog.load(config.catalogDir);
  const engine = new TorrentEngine({
    dataDir: path.join(config.workDir, 'torrents'),
    port: config.torrent.port,
    dht: config.torrent.dht,
    trackers: config.torrent.trackers,
    webSeeds: config.torrent.webSeeds,
    allowPrivatePeers: config.torrent.allowPrivatePeers,
    maxConns: config.torrent.maxConns,
    uploadLimitKiBps: config.torrent.uploadLimitKiBps,
    lingerMs: config.torrentLingerSec * 1000,
    cacheMaxBytes: config.torrentCacheMaxMiB * 1024 * 1024,
    readWindowBytes: config.torrentReadWindowMiB * 1024 * 1024,
  });
  await engine.start();
  const sourceServer = new TorrentSourceServer();
  await sourceServer.listen();
  const manager = new SessionManager({
    config,
    catalog,
    engine,
    sourceServer,
    ...(opts.bootstrapPeers ? { bootstrapPeers: opts.bootstrapPeers } : {}),
  });
  await manager.start();
  const server = await buildServer({
    config,
    catalog,
    manager,
    engine,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });

  return {
    server,
    manager,
    engine,
    close: async () => {
      await server.close();
      await manager.shutdown();
      await sourceServer.close();
      await engine.destroy();
    },
  };
}
