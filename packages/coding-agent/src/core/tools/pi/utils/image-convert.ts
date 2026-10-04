// Adapted from Pi c20cb09772bf4e2590a316cb54514cef76df4293.
// Copyright (c) 2025 Mario Zechner. MIT license: THIRD_PARTY_NOTICES.md.
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const photon = await loadPhoton();
  if (!photon) {
    // Photon not available, can't convert
    return null;
  }

  try {
    const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
    const image = applyExifOrientation(photon, rawImage, bytes);
    if (image !== rawImage) rawImage.free();
    try {
      return new Uint8Array(image.get_bytes());
    } finally {
      image.free();
    }
  } catch {
    // Conversion failed
    return null;
  }
}
