/** Bound the complete operation, including body consumption, even if abort stalls. */
export async function withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException(`请求超过 ${ms} ms`, 'TimeoutError');
      reject(error);
      controller.abort(error);
    }, ms);
  });
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}
