"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "wip-notice-minimized";

// The work-in-progress notice now lives in the same bar as sign-in, so it has
// to own that bar: the chip sits inside the flex row while the panel it opens
// hangs below it, and only a component wrapping both can place them in two
// different parents. `children` is the bar's own content, server-rendered in
// layout.js — including the sign-out form, whose server action survives being
// passed through a client boundary as children.
export default function TopBar({ children, notice, researchDirectionUrl }) {
  // Server-renders collapsed on purpose. Once someone has minimized it the
  // panel must never flash back on the next visit, and localStorage can only
  // be read after mount — so first-timers get the panel one paint late
  // instead, which is the cheaper of the two wrong first frames.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!notice) return;
    let minimized = false;
    try {
      minimized = window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      // Storage blocked (private mode, cookies off) — treat as never minimized.
    }
    if (!minimized) setOpen(true);
  }, [notice]);

  // Minimizing is the choice we remember; expanding again later doesn't undo
  // it, so a visitor who reopens the notice out of curiosity doesn't get it
  // pushed at them on every subsequent page load.
  function collapse() {
    setOpen(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Nothing to do — it just reopens next visit.
    }
  }

  return (
    <header className="top-bar">
      <div className="auth-bar">
        {notice && (
          <button
            type="button"
            className={`wip-chip${open ? " open" : ""}`}
            aria-expanded={open}
            aria-controls="wip-panel"
            onClick={() => (open ? collapse() : setOpen(true))}
          >
            <span className="wip-dot" aria-hidden="true" />
            Work in progress
            <span className="wip-caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
          </button>
        )}
        {children}
      </div>
      {notice && open && (
        <aside id="wip-panel" className="wip-panel" aria-label="Work in progress">
          <div className="wip-panel-body">
            <p>
              This is an early preview intended to show the direction this project could take. It
              currently includes only a few models, a limited selection of argumentation styles, and
              two example scenarios that have not yet been fully validated. No statistically
              significant results or conclusions are presented here yet, and several aspects of the
              results display still need improvement.
            </p>
            <p>
              For feedback—or to request internal access to experiment with scenario generation and
              evaluation runs—feel free to contact{" "}
              <a href="mailto:sam@polariscollective.org">sam@polariscollective.org</a>.
            </p>
            {researchDirectionUrl && (
              <p>
                <strong>More info:</strong>{" "}
                <a href={researchDirectionUrl}>Information about the research direction</a>
              </p>
            )}
          </div>
          <button type="button" className="wip-minimize" onClick={collapse}>
            Minimize
          </button>
        </aside>
      )}
    </header>
  );
}
