// SPDX-FileCopyrightText: 2026 rockykln
// SPDX-License-Identifier: Apache-2.0
// Internal helper of index.mjs; not exported from the package.

/**
 * Returns a feed function that splits a text stream into lines and calls `onLine` for every
 * non-blank line. Each chunk is scanned once and partial lines are joined only when their newline
 * arrives, so a huge line costs linear time. Throws once a partial line exceeds `maxLength`
 * characters (UTF-16 code units) and drops the buffered part.
 * @param {(line: string) => void} onLine
 * @param {number} maxLength
 * @returns {(chunk: string) => void}
 */
export function lineSplitter(onLine, maxLength) {
  /** @type {string[]} */
  let parts = [];
  let partLength = 0;
  return (chunk) => {
    let start = 0;
    let nl = chunk.indexOf("\n");
    while (nl >= 0) {
      let line = chunk.slice(start, nl);
      if (parts.length) {
        if (partLength + line.length > maxLength) {
          parts = [];
          partLength = 0;
          throw new Error("incoming line too long");
        }
        parts.push(line);
        line = parts.join("");
        parts = [];
        partLength = 0;
      } else if (line.length > maxLength) {
        throw new Error("incoming line too long");
      }
      if (line.trim()) onLine(line);
      start = nl + 1;
      nl = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) {
      const rest = start === 0 ? chunk : chunk.slice(start);
      partLength += rest.length;
      if (partLength > maxLength) {
        parts = [];
        partLength = 0;
        throw new Error("incoming line too long");
      }
      parts.push(rest);
    }
  };
}
