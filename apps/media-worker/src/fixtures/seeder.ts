import { readFile } from 'node:fs/promises';
import WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';

export interface Seeder {
  /** `127.0.0.1:<port>` peer address for the leecher to dial. */
  address: string;
  torrents: Torrent[];
  close: () => Promise<void>;
}

/**
 * Seeds an existing torrent from data already on disk, as an independent
 * BitTorrent peer listening on loopback. Used to run a real (local) swarm in
 * tests and development without any third-party network dependency.
 */
export async function startSeeder(opts: {
  /** Every torrent to seed from `dataPath` (one BitTorrent client, one port). */
  torrentPaths: string[];
  dataPath: string;
  port?: number;
}): Promise<Seeder> {
  const client = new WebTorrent({
    torrentPort: opts.port ?? 0,
    dht: false,
    tracker: false,
    lsd: false,
    utPex: false,
    natUpnp: false,
    natPmp: false,
    utp: false,
  });
  client.on('error', () => undefined);
  const torrents: Torrent[] = [];
  for (const torrentPath of opts.torrentPaths) {
    const torrentFile = await readFile(torrentPath);
    torrents.push(
      await new Promise<Torrent>((resolve, reject) => {
        const t = client.add(torrentFile, { path: opts.dataPath });
        t.once('error', reject);
        // Existing data is hash-checked on add; it seeds once every piece verified.
        if (t.progress === 1) resolve(t);
        else t.once('done', () => resolve(t));
      }),
    );
  }
  const addr = await waitForAddress(client);
  return {
    address: `127.0.0.1:${addr.port}`,
    torrents,
    close: () =>
      new Promise<void>((resolve) => {
        client.destroy(() => {
          resolve();
        });
      }),
  };
}

async function waitForAddress(client: WebTorrent): Promise<{ port: number }> {
  for (let i = 0; i < 100; i++) {
    const addr = client.address();
    if (addr && addr.port > 0) return addr;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Seeder did not start listening');
}
