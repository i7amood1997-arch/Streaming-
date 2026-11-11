import { readFile } from 'node:fs/promises';
import WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';

export interface Seeder {
  /** `127.0.0.1:<port>` peer address for the leecher to dial. */
  address: string;
  torrent: Torrent;
  close: () => Promise<void>;
}

/**
 * Seeds an existing torrent from data already on disk, as an independent
 * BitTorrent peer listening on loopback. Used to run a real (local) swarm in
 * tests and development without any third-party network dependency.
 */
export async function startSeeder(opts: {
  torrentPath: string;
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
  const torrentFile = await readFile(opts.torrentPath);
  const torrent = await new Promise<Torrent>((resolve, reject) => {
    client.on('error', reject);
    const t = client.add(torrentFile, { path: opts.dataPath });
    const onDone = () => {
      resolve(t);
    };
    // Existing data is hash-checked on add; it seeds once every piece verified.
    if (t.progress === 1) onDone();
    else t.once('done', onDone);
  });
  const addr = await waitForAddress(client);
  return {
    address: `127.0.0.1:${addr.port}`,
    torrent,
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
