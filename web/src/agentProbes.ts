export function createAgentProbeRequests<T>(request: (id: string) => Promise<T>) {
  const pending = new Map<string, Promise<T>>();
  return {
    entries: () => [...pending.entries()],
    async resume(load: () => Promise<void>, observe: (id: string, result: Promise<T>) => Promise<void>) {
      const inherited = [...pending.entries()];
      await load();
      await Promise.all(inherited.map(([id, result]) => observe(id, result)));
    },
    run(id: string) {
      const existing = pending.get(id);
      if (existing) return existing;
      const result = Promise.resolve().then(() => request(id)).finally(() => pending.delete(id));
      pending.set(id, result);
      return result;
    },
  };
}
