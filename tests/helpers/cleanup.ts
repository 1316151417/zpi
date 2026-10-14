export type CleanupAction = () => unknown | Promise<unknown>;

/** Release dependent resources first, without letting one failure skip the rest. */
export async function runCleanup(actions: CleanupAction[]): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions.splice(0).reverse()) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Test resource cleanup failed");
}
