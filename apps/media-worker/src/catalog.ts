import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * The catalog is the authorization boundary: only torrents recorded here, with
 * an explicit licence and provenance, can ever be streamed. There is no API to
 * stream an arbitrary magnet link or infohash.
 */
const LicenseSchema = z.enum([
  'public-domain',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
]);

const CatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  title: z.string().min(1),
  license: LicenseSchema,
  licenseUrl: z.url(),
  attribution: z.string().min(1),
  /** Where the rights evidence lives (e.g. archive.org item page, Blender Foundation page). */
  provenanceUrl: z.string().min(1),
  infoHash: z.string().regex(/^[0-9a-f]{40}$/),
  /** Path to the .torrent file, relative to the catalog directory. */
  torrentFile: z.string().min(1),
  /** Index of the main video file inside the torrent. */
  videoFileIndex: z.number().int().min(0),
});

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type License = z.infer<typeof LicenseSchema>;

const CatalogSchema = z.object({ version: z.literal(1), entries: z.array(CatalogEntrySchema) });

export class Catalog {
  private readonly byId: Map<string, CatalogEntry>;

  private constructor(
    private readonly dir: string,
    entries: CatalogEntry[],
  ) {
    this.byId = new Map(entries.map((e) => [e.id, e]));
  }

  static async load(dir: string): Promise<Catalog> {
    const raw: unknown = JSON.parse(await readFile(path.join(dir, 'catalog.json'), 'utf8'));
    const { entries } = CatalogSchema.parse(raw);
    return new Catalog(dir, entries);
  }

  get(id: string): CatalogEntry | undefined {
    return this.byId.get(id);
  }

  list(): CatalogEntry[] {
    return [...this.byId.values()];
  }

  async readTorrentFile(entry: CatalogEntry): Promise<Buffer> {
    const resolved = path.resolve(this.dir, entry.torrentFile);
    if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error(`Catalog entry ${entry.id} points outside the catalog directory`);
    }
    return readFile(resolved);
  }
}
