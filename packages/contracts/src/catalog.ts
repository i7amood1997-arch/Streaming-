import { z } from 'zod';

export const LicenseSchema = z.enum([
  'public-domain',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
]);
export type License = z.infer<typeof LicenseSchema>;

export const CatalogItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  license: LicenseSchema,
  licenseUrl: z.url(),
  attribution: z.string(),
});
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const CatalogResponseSchema = z.object({ items: z.array(CatalogItemSchema) });
