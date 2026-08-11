"use client";

import { useRef, useState } from "react";

// A run id is the handle for talking about one specific run — in a message, a
// query, a bug report. Printing it is not enough: these are UUIDs, and
// selecting one by hand out of a dense row is exactly the friction that stops
// people quoting it at all.
//
// Truncated visually, never in what gets copied.
export default function CopyId({ id }) {
  const [copied, setCopied] = useState(false);
  const valueRef = useRef(null);

  if (!id) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // navigator.clipboard is unavailable on an insecure origin and can be
      // refused by permission policy. Select the id instead so ⌘C still works,
      // rather than a button that silently does nothing.
      const node = valueRef.current;
      if (!node) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  return (
    <span className="copy-id">
      <code ref={valueRef} className="copy-id-value" title={id}>
        {id}
      </code>
      <button type="button" className="copy-id-btn" onClick={copy} aria-label={`Copy run id ${id}`}>
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}
