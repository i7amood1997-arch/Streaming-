import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const titleKind = pgEnum('title_kind', ['movie', 'series', 'episode']);

export const license = pgEnum('license', [
  'public-domain',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
]);

/** A work in the catalog (film, series or episode), independent of where its media comes from. */
export const titles = pgTable(
  'titles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    kind: titleKind('kind').notNull(),
    title: text('title').notNull(),
    originalTitle: text('original_title'),
    year: integer('year'),
    synopsis: text('synopsis'),
    runtimeSec: integer('runtime_sec'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('titles_slug_key').on(t.slug),
    check('titles_slug_format', sql`${t.slug} ~ '^[a-z0-9-]{1,64}$'`),
    check('titles_year_range', sql`${t.year} IS NULL OR ${t.year} BETWEEN 1870 AND 2200`),
  ],
);

/** Localised title/synopsis (en, ar, ...). */
export const titleLocalizations = pgTable(
  'title_localizations',
  {
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    title: text('title').notNull(),
    synopsis: text('synopsis'),
  },
  (t) => [primaryKey({ columns: [t.titleId, t.locale] })],
);

/**
 * The authorization record: a specific torrent that may be streamed for a
 * title, with the licence evidence that makes it legal. Nothing outside this
 * table can ever be played.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'restrict' }),
    infohash: text('infohash').notNull(),
    torrent: bytea('torrent').notNull(),
    videoFileIndex: integer('video_file_index').notNull(),
    maxHeight: integer('max_height'),
    videoCodec: text('video_codec'),
    license: license('license').notNull(),
    licenseUrl: text('license_url').notNull(),
    attribution: text('attribution').notNull(),
    provenanceUrl: text('provenance_url').notNull(),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sources_infohash_key').on(t.infohash),
    check('sources_infohash_format', sql`${t.infohash} ~ '^[0-9a-f]{40}$'`),
    check('sources_video_file_index_nonneg', sql`${t.videoFileIndex} >= 0`),
    check('sources_verified_pair', sql`(${t.verifiedBy} IS NULL) = (${t.verifiedAt} IS NULL)`),
  ],
);
