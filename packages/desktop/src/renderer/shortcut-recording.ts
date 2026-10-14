/** Invalidates an in-flight capture acknowledgement on blur, unmount or a newer recording. */
export class ShortcutRecordingRequest {
  private revision = 0;
  cancel(): void {
    this.revision++;
  }
  async start(request: () => Promise<unknown>): Promise<boolean> {
    const revision = ++this.revision;
    try {
      await request();
    } catch (error) {
      if (revision === this.revision) throw error;
      return false;
    }
    return revision === this.revision;
  }
}
