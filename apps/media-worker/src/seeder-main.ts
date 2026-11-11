import { DEFAULT_FIXTURES_DIR, ensureFixtures } from './fixtures/generate.js';
import { startSeeder } from './fixtures/seeder.js';

/** Dev helper: seeds the CC0 fixture on a fixed loopback port. */
const port = Number(process.env['SEED_PORT'] ?? 51413);
const fixtures = await ensureFixtures(DEFAULT_FIXTURES_DIR);
const seeder = await startSeeder({
  torrentPaths: fixtures.torrentPaths,
  dataPath: fixtures.mediaRoot,
  port,
});
process.stdout.write(
  `Seeding ${String(seeder.torrents.length)} catalog torrents at ${seeder.address}\n` +
    `Start the server with: TORRENT_BOOTSTRAP_PEERS=${seeder.address} TORRENT_ALLOW_PRIVATE_PEERS=true TORRENT_DHT=false TORRENT_TRACKERS=false pnpm start\n`,
);
process.on('SIGINT', () => {
  void seeder.close().then(() => process.exit(0));
});
