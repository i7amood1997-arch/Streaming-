CREATE TYPE "public"."license" AS ENUM('public-domain', 'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-4.0');--> statement-breakpoint
CREATE TYPE "public"."title_kind" AS ENUM('movie', 'series', 'episode');--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"infohash" text NOT NULL,
	"torrent" "bytea" NOT NULL,
	"video_file_index" integer NOT NULL,
	"max_height" integer,
	"video_codec" text,
	"license" "license" NOT NULL,
	"license_url" text NOT NULL,
	"attribution" text NOT NULL,
	"provenance_url" text NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_infohash_format" CHECK ("sources"."infohash" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "sources_video_file_index_nonneg" CHECK ("sources"."video_file_index" >= 0),
	CONSTRAINT "sources_verified_pair" CHECK (("sources"."verified_by" IS NULL) = ("sources"."verified_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "title_localizations" (
	"title_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"synopsis" text,
	CONSTRAINT "title_localizations_title_id_locale_pk" PRIMARY KEY("title_id","locale")
);
--> statement-breakpoint
CREATE TABLE "titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"kind" "title_kind" NOT NULL,
	"title" text NOT NULL,
	"original_title" text,
	"year" integer,
	"synopsis" text,
	"runtime_sec" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "titles_slug_format" CHECK ("titles"."slug" ~ '^[a-z0-9-]{1,64}$'),
	CONSTRAINT "titles_year_range" CHECK ("titles"."year" IS NULL OR "titles"."year" BETWEEN 1870 AND 2200)
);
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_localizations" ADD CONSTRAINT "title_localizations_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_infohash_key" ON "sources" USING btree ("infohash");--> statement-breakpoint
CREATE UNIQUE INDEX "titles_slug_key" ON "titles" USING btree ("slug");