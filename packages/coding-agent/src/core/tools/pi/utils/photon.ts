// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: THIRD_PARTY_NOTICES.md.
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

let photon: Promise<typeof import("@silvia-odwyer/photon-node") | null> | undefined;
export function loadPhoton() {
  photon ??= import("@silvia-odwyer/photon-node").catch(() => null);
  return photon;
}
