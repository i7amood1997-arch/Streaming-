import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('treats empty variables as unset and generates a token secret', () => {
    const config = loadConfig({
      STREAM_TOKEN_SECRET: '',
      PUBLIC_BASE_URL: '',
      ALLOWED_ORIGINS: '',
    });
    expect(config.streamTokenSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.publicBaseUrl).toBeUndefined();
    expect(config.allowedOrigins).toEqual([]);
    expect(config.torrent.allowPrivatePeers).toBe(false);
  });

  it('parses typed values and rejects invalid ones', () => {
    const config = loadConfig({
      MAX_SESSIONS: '8',
      TORRENT_DHT: 'false',
      ALLOWED_ORIGINS: 'capacitor://localhost, https://app.example.com',
    });
    expect(config.maxSessions).toBe(8);
    expect(config.torrent.dht).toBe(false);
    expect(config.allowedOrigins).toEqual(['capacitor://localhost', 'https://app.example.com']);
    expect(() => loadConfig({ STREAM_TOKEN_SECRET: 'short' })).toThrow();
    expect(() => loadConfig({ HLS_SEGMENT_DURATION_SEC: '1' })).toThrow();
  });
});
