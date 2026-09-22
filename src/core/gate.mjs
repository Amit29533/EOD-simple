/**
 * A concurrency gate with a bounded waiting line.
 *
 * `run(fn)` executes `fn` when one of `concurrency` slots is free, queues it
 * (FIFO) while none is, and refuses it at once — `err.code === 'GATE_FULL'` —
 * when `maxWaiting` jobs are already queued. Refusing cheaply is the point:
 * the work behind the gate is expensive, and a caller that cannot be served
 * soon should be told so in microseconds rather than parked for seconds.
 *
 * Used for password verification. A scrypt verify is ~45 ms on Node's
 * libuv threadpool (4 threads by default, FIFO), which is also where every
 * `fs.promises` read of a static file runs. Sign-in attempts used to go
 * straight onto that pool, so a burst of them — a room signing in together,
 * or a flood of made-up usernames from one address — queued hundreds of
 * scrypt jobs ahead of everything else: static files took seconds and a
 * genuine sign-in a second or more. Two slots leave two threads for the rest
 * of the server whatever arrives.
 */
export function createGate({ concurrency = 2, maxWaiting = 200 } = {}) {
  let inFlight = 0;
  const waiting = [];

  const next = () => {
    while (inFlight < concurrency && waiting.length) {
      const job = waiting.shift();
      inFlight += 1;
      job.start();
    }
  };

  const execute = async (fn) => {
    try {
      return await fn();
    } finally {
      inFlight -= 1;
      next();
    }
  };

  return {
    run(fn) {
      if (inFlight < concurrency) {
        inFlight += 1;
        return execute(fn);
      }
      if (waiting.length >= maxWaiting) {
        const err = new Error('Too many jobs waiting');
        err.code = 'GATE_FULL';
        return Promise.reject(err);
      }
      return new Promise((resolve, reject) => {
        waiting.push({ start: () => execute(fn).then(resolve, reject) });
      });
    },
    get inFlight() { return inFlight; },
    get waiting() { return waiting.length; },
    concurrency,
    maxWaiting,
  };
}
