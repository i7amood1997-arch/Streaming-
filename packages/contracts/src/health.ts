import { z } from 'zod';

/** Liveness: the process is up. Never touches dependencies. */
export const LivenessResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
});
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

export const DependencyCheckSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  error: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

/** Readiness: every dependency needed to serve traffic answered in time. */
export const ReadinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), DependencyCheckSchema),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
