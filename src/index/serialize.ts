// Minimal in-process write serializer (the slice of the Build Spec's "in-process queue"
// needed for index correctness: the async embed -> sync DB write critical section must
// not interleave). FIFO; a rejected task does not break the chain for later tasks.

export class Serializer {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
