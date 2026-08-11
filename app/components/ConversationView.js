"use client";

import { useState } from "react";

// Toggle showing the exact system + user (or initial user) prompt that
// produced a result, verbatim — so any claim about "what the model saw"
// can be checked directly instead of inferred.
export function PromptViewer({ systemPrompt, userMessage, tools, label = "View exact input prompt" }) {
  const [open, setOpen] = useState(false);
  if (!systemPrompt && !userMessage && !tools?.length) return null;
  return (
    <>
      <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} style={{ marginTop: 8 }}>
        {open ? "Hide exact input prompt ▾" : `${label} ▸`}
      </button>
      {open && (
        <div className="raw-block">
          <div className="io-label">system prompt</div>
          {systemPrompt || "(none)"}
          <div className="io-label" style={{ marginTop: 12 }}>
            {label.includes("adversary") ? "user prompt" : "initial user message"}
          </div>
          {userMessage || "(none)"}
          {/* Tool schemas reach the model through the API's own `tools`
              field, never as message text, so reading the prompt above
              alone would understate what it was shown. The plan stage is
              the one exception — it sends no tools and inlines the same
              information into its system prompt — and correctly renders
              nothing here. */}
          {tools?.length > 0 && (
            <>
              <div className="io-label" style={{ marginTop: 12 }}>
                tool definitions sent alongside this prompt ({tools.length})
              </div>
              {tools.map((t) => (
                <div key={t.name} style={{ marginTop: 8 }}>
                  {t.name}
                  {"\n"}
                  {t.description}
                  {"\n"}
                  {JSON.stringify(t.input_schema)}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

export function AdversaryTurn({ t }) {
  return (
    <div className="adversary-turn">
      <div className="turn-label">
        turn {t.turn} — adversary <span className="mono">({t.argument_style})</span>
      </div>
      <div>{t.text}</div>
      {t.cost != null && <div className="turn-cost">${t.cost.toFixed(4)}</div>}
      <PromptViewer systemPrompt={t.system_prompt} userMessage={t.user_prompt} label="View adversary's prompt" />
    </div>
  );
}

// Renders an executor's response, collapsed by default when the exchange
// spanned more than one turn (only the final response is shown), with a
// toggle to expand the full adversary/executor conversation exactly as it
// happened. `startExpanded` skips the collapsed state entirely — used by
// the compare page's transcript modal, where the whole point of opening it
// is to read the full exchange immediately.
export function TurnBody({ turns, startExpanded = false }) {
  const [expanded, setExpanded] = useState(startExpanded);
  const executorTurns = (turns || []).filter((t) => t.role === "executor");
  const last = executorTurns[executorTurns.length - 1];

  const renderPayload = (t) =>
    t.payload?.tool && (
      <div className="output-line mono">
        called {t.payload.tool} — {JSON.stringify(t.payload.arguments)}
      </div>
    );

  if (!turns || turns.length <= 1) {
    return (
      <>
        <pre className="turn-pre">{last?.text || "(tool call, no text)"}</pre>
        {last && renderPayload(last)}
      </>
    );
  }

  return (
    <>
      {!startExpanded && <pre className="turn-pre">{last?.text || "(tool call, no text)"}</pre>}
      {!startExpanded && last && renderPayload(last)}
      {!startExpanded && (
        <button className="btn btn-ghost" onClick={() => setExpanded((v) => !v)} style={{ marginTop: 8 }}>
          {expanded ? "Collapse conversation ▾" : `Show full conversation (${turns.length} turns) ▸`}
        </button>
      )}
      {expanded && (
        <div className="turn-thread">
          {turns.map((t, i) =>
            t.role === "adversary" ? (
              <AdversaryTurn key={i} t={t} />
            ) : (
              <div key={i} className={`log-entry ${t.accepted ? "ok" : "danger"}`}>
                <div className="log-entry-head">
                  <span className="log-entry-idx">turn {t.turn}</span>
                  <span className={`badge ${t.accepted ? "badge-ok" : "badge-danger"}`}>
                    {t.accepted ? "accepted" : "refused"}
                  </span>
                  {t.truncated && <span className="badge badge-warn">truncated</span>}
                </div>
                <pre className="turn-pre">{t.text || "(tool call, no text)"}</pre>
                {renderPayload(t)}
                {t.cost != null && <div className="turn-cost">${t.cost.toFixed(4)}</div>}
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}

export function turnsCost(turns) {
  return (turns || []).reduce((sum, t) => sum + (t.cost || 0), 0);
}
