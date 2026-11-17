// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Groups an unpadded base64 key in blocks of 4 for comparing by eye. */
export function fingerprint(key: string): string {
  return key.replace(/(.{4})/g, "$1 ").trim();
}
