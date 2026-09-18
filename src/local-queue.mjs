export class LocalQueue {
  constructor() { this.queues = new Map(); }
  acquire(key, signal) {
    if (!key) return Promise.resolve(() => {});
    signal.throwIfAborted();
    const queue = this.queues.get(key) || [];
    if (queue.length >= 32) return Promise.reject(new Error("本地模型等待队列已满"));
    this.queues.set(key, queue);
    return new Promise((resolve, reject) => {
      const entry = { start: () => {
        signal.removeEventListener("abort", cancel);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          queue.shift();
          if (queue.length) queue[0].start();
          else this.queues.delete(key);
        });
      } };
      const cancel = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", cancel, { once: true });
      queue.push(entry);
      if (queue.length === 1) entry.start();
    });
  }
}
