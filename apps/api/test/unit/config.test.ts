import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadApiConfig', () => {
  it('applies defaults and treats empty values as unset', () => {
    const c = loadApiConfig({ ...base, API_PORT: '', ALLOWED_ORIGINS: '' });
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      allowedOrigins: [],
      migrateOnStart: false,
    });
  });

  it('requires valid database and redis URLs', () => {
    expect(() => loadApiConfig({ REDIS_URL: base.REDIS_URL })).toThrow();
    expect(() => loadApiConfig({ ...base, DATABASE_URL: 'mysql://x' })).toThrow();
    expect(() => loadApiConfig({ ...base, REDIS_URL: 'http://x' })).toThrow();
  });

  it('parses typed values', () => {
    const c = loadApiConfig({
      ...base,
      API_PORT: '8081',
      MIGRATE_ON_START: 'true',
      ALLOWED_ORIGINS: 'a, b',
    });
    expect(c).toMatchObject({ port: 8081, migrateOnStart: true, allowedOrigins: ['a', 'b'] });
  });
});
