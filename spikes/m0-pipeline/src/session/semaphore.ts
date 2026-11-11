/** Counting semaphore with FIFO waiters and acquisition timeout. */
export class Semaphore {
  private inUse = 0;
  private readonly queue: { resolve: (release: () => void) => void; timer: NodeJS.Timeout }[] = [];

  constructor(private readonly capacity: number) {}

  get available(): number {
    return this.capacity - this.inUse;
  }

  get waiting(): number {
    return this.queue.length;
  }

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.inUse < this.capacity) {
      this.inUse += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i !== -1) this.queue.splice(i, 1);
          reject(new Error('Timed out waiting for a transcode slot'));
        }, timeoutMs),
      };
      this.queue.push(entry);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.releaser());
      } else {
        this.inUse -= 1;
      }
    };
  }
}
