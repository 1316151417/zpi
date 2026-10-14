import type { useStore } from "./store.ts";

type Store = ReturnType<typeof useStore.getState>;

export function selectAppState(state: Store) {
  const id = state.selected ?? "";
  return {
    taskGroups: state.taskGroups,
    taskGroupsHydrated: state.taskGroupsHydrated,
    projects: state.projects,
    selected: state.selected,
    settings: state.settings,
    error: state.error,
    ready: state.ready,
    activeRecord: state.sessions.get(id),
    activeView: state.views.get(id),
    activeSuggestions: state.suggestions.get(id),
    activeDiagnostics: state.resourceDiagnostics.get(id),
    historyCursor: state.historyCursors.get(id),
    loadingEarlier: state.historyLoading.has(id),
  };
}

export function selectTaskRecords(state: Store) {
  return [...state.sessions.values()].filter((record) => !record.draft && !record.parentSessionId);
}
