export const autoArchiveDays = [3, 7, 14, 30] as const;

export interface AutoArchiveSettings {
  enabled: boolean;
  olderThanDays: (typeof autoArchiveDays)[number];
}

export interface AutoArchiveResult {
  archived: number;
  skipped: number;
  details: { sessionId: string; title: string; reason: string }[];
}

export const defaultAutoArchiveSettings: AutoArchiveSettings = {
  enabled: false,
  olderThanDays: 30,
};

export function isAutoArchiveSettings(value: unknown): value is AutoArchiveSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return (
    Object.keys(settings).every((key) => key === "enabled" || key === "olderThanDays") &&
    typeof settings.enabled === "boolean" &&
    autoArchiveDays.some((days) => days === settings.olderThanDays)
  );
}
