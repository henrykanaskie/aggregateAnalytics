import React, { useState } from "react";
import Tailor from "./Tailor";
import { useMeta } from "../state";
import { Tags, useLens } from "../lib/profile";

export interface Tucked { id: string; label: string; node: React.ReactNode }

/** Panels the tailoring answers moved off the page. They sit here closed, so
 *  nothing is rendered or fetched for them until someone opens one, and any of
 *  them can be brought back up for good. */
export default function More({ items }: { items: Tucked[] }) {
  const { settings, setSettings } = useMeta();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const profile = settings.profile;
  if (!items.length || !profile) return null;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pin = (id: string) => setSettings({ profile: { ...profile, pinned: [...new Set([...profile.pinned, id])] } });
  return (
    <section className="more-panels">
      <div className="more-head">
        <h3>More, outside your interests · {items.length}</h3>
        <span className="hint">Moved down here because of your answers. Open one to look, or bring it back up for good. <button className="linkish" onClick={() => setEditing(true)}>Change answers</button></span>
      </div>
      {items.map((it) => (
        <div key={it.id} className="more-item">
          <div className="more-row">
            <button className="more-toggle" aria-expanded={open.has(it.id)} onClick={() => toggle(it.id)}>{open.has(it.id) ? "▾" : "▸"} {it.label}</button>
            <button className="btn sm ghost" title="Show this panel in its usual place from now on" onClick={() => pin(it.id)}>Always show</button>
          </div>
          {open.has(it.id) && <div className="more-body">{it.node}</div>}
        </div>
      ))}
      {editing && <Tailor onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />}
    </section>
  );
}

/** The same idea inside a panel: a section the profile has no use for folds
 *  to one line where it stands, instead of moving to the bottom of the page. */
export function Folded({ id, label, tags, children }: { id: string; label: string; tags: Tags; children: React.ReactNode }) {
  const lens = useLens();
  const [open, setOpen] = useState(false);
  if (lens.shows(id, tags)) return <>{children}</>;
  return (
    <div className="folded">
      <button className="more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {label} <span className="faint">· outside your interests</span></button>
      {open && <div className="more-body">{children}</div>}
    </div>
  );
}
