import { z } from 'zod';

export const QualitySchema = z.enum(['480p', '720p', '1080p', '2160p']);
export type Quality = z.infer<typeof QualitySchema>;

export const ClientCapabilitiesSchema = z.object({
  /** Client can decode HEVC (detected with canPlayType / MediaSource.isTypeSupported). */
  hevc: z.boolean().default(false),
  maxHeight: z.number().int().min(144).max(4320).default(1080),
});

export const CreatePlaybackSessionRequestSchema = z.object({
  contentId: z.string().min(1).max(64),
  quality: z.union([QualitySchema, z.literal('auto')]).default('auto'),
  startPositionSec: z
    .number()
    .min(0)
    .max(24 * 3600)
    .default(0),
  preferredAudioLanguage: z
    .string()
    .regex(/^[a-z]{2,3}$/)
    .optional(),
  capabilities: ClientCapabilitiesSchema.default({ hevc: false, maxHeight: 1080 }),
});
export type CreatePlaybackSessionRequest = z.infer<typeof CreatePlaybackSessionRequestSchema>;

export const PlaybackDecisionSchema = z.object({ code: z.string(), message: z.string() });

export const PlaybackSessionResponseSchema = z.object({
  sessionId: z.uuid(),
  /** Capability URL; absolute when the worker knows its public origin. */
  masterPlaylistUrl: z.string(),
  expiresAt: z.iso.datetime(),
  durationSec: z.number(),
  video: z.object({
    width: z.number().int(),
    height: z.number().int(),
    quality: QualitySchema,
    codecs: z.string(),
  }),
  subtitles: z.array(
    z.object({
      language: z.string(),
      name: z.string(),
      forced: z.boolean(),
      rtl: z.boolean(),
    }),
  ),
  decisions: z.array(PlaybackDecisionSchema),
});
export type PlaybackSessionResponse = z.infer<typeof PlaybackSessionResponseSchema>;
