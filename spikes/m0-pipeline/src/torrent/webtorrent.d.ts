/**
 * Minimal typings for the subset of WebTorrent v3 used by the engine.
 * @types/webtorrent targets older major versions; keeping our own narrow
 * surface makes upgrades explicit and keeps the rest of the code strictly typed.
 */
declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events';
  import type { Readable } from 'node:stream';

  export interface WebTorrentOptions {
    torrentPort?: number;
    dht?: boolean | object;
    tracker?: boolean | object;
    lsd?: boolean;
    utPex?: boolean;
    natUpnp?: boolean;
    natPmp?: boolean;
    utp?: boolean;
    webSeeds?: boolean;
    maxConns?: number;
    uploadLimit?: number;
    downloadLimit?: number;
    blocklist?: string[];
  }

  export interface AddOptions {
    path?: string;
    deselect?: boolean;
    strategy?: 'sequential' | 'rarest';
    announce?: string[];
  }

  export interface TorrentFile {
    readonly name: string;
    readonly path: string;
    readonly length: number;
    readonly offset: number;
    readonly done: boolean;
    readonly downloaded: number;
    createReadStream(opts?: { start?: number; end?: number }): Readable;
  }

  export interface Torrent extends EventEmitter {
    readonly infoHash: string;
    readonly name: string;
    readonly files: TorrentFile[];
    readonly length: number;
    readonly ready: boolean;
    readonly downloaded: number;
    readonly uploaded: number;
    readonly downloadSpeed: number;
    readonly uploadSpeed: number;
    readonly numPeers: number;
    readonly progress: number;
    readonly torrentFile: Buffer;
    addPeer(peer: string): boolean;
    destroy(opts?: { destroyStore?: boolean }, cb?: (err: Error | null) => void): void;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrentOptions);
    static readonly VERSION: string;
    readonly torrents: Torrent[];
    readonly torrentPort: number;
    add(torrentId: Buffer | string, opts?: AddOptions, onTorrent?: (t: Torrent) => void): Torrent;
    seed(
      input: string | string[],
      opts?: AddOptions & { name?: string },
      onSeed?: (t: Torrent) => void,
    ): Torrent;
    get(torrentId: string): Promise<Torrent | null>;
    address(): { address: string; port: number } | null;
    destroy(cb?: (err: Error | null) => void): void;
  }
}
