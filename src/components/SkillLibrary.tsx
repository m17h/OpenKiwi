import { useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Boxes, Check, FilePlus2, FolderOpen, LoaderCircle, Pencil, Plus, RefreshCw, Search, X } from "lucide-react";
import type { LocalSkill } from "../lib/skills";

export function SkillLibrary({
  folder,
  skills,
  busy,
  error,
  onChooseFolder,
  onRefresh,
  onImport,
  onCreate,
  onRename,
  onToggle,
}: {
  folder: string;
  skills: LocalSkill[];
  busy: boolean;
  error: string;
  onChooseFolder: () => void;
  onRefresh: () => void;
  onImport: () => void;
  onCreate: (name: string, instructions: string) => Promise<boolean>;
  onRename: (path: string, name: string) => boolean;
  onToggle: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [createName, setCreateName] = useState("");
  const [createInstructions, setCreateInstructions] = useState("");
  const [creating, setCreating] = useState(false);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.fileName} ${skill.description}`.toLowerCase().includes(needle));
  }, [query, skills]);

  const create = async () => {
    if (!createName.trim() || !createInstructions.trim()) return;
    setCreating(true);
    const created = await onCreate(createName, createInstructions);
    setCreating(false);
    if (created) {
      setCreateName("");
      setCreateInstructions("");
    }
  };

  return (
    <section className="settings-section skill-library-section">
      <div className="settings-section-heading settings-heading-with-action">
        <div className="settings-icon"><Boxes size={17} /></div>
        <div><h3>Local skill library</h3><p>Markdown workflows that OpenKiwi exposes by name to both OpenAI and OpenRouter models.</p></div>
        {folder && <button className="secondary-button" onClick={onRefresh} disabled={busy}>{busy ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />} Rescan</button>}
      </div>

      <div className={`skill-folder-card ${folder ? "selected" : "empty"}`}>
        <span className="skill-folder-icon"><FolderOpen size={19} /></span>
        <span><strong>{folder ? "Skills folder" : "Choose a skills folder"}</strong><small>{folder || "Pick any local folder containing Markdown skill files."}</small></span>
        <button className={folder ? "secondary-button" : "primary-button"} onClick={onChooseFolder}>{folder ? "Change" : "Choose folder"}</button>
      </div>

      {folder && <>
        <div className="skill-library-toolbar">
          <label><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" /></label>
          <button className="secondary-button" onClick={onImport}><FilePlus2 size={13} /> Import Markdown</button>
          <button className="secondary-button" onClick={() => void revealItemInDir(folder)}><FolderOpen size={13} /> Show folder</button>
        </div>

        <div className="skill-library-summary">
          <span><strong>{skills.filter((skill) => skill.enabled).length}</strong> enabled</span>
          <span><strong>{skills.length}</strong> detected</span>
          <small>Top-level `.md` files and nested `SKILL.md` packages are detected. Rename changes only the invocation name in OpenKiwi.</small>
        </div>

        <div className="skill-card-list">
          {filtered.map((skill) => (
            <div className={`skill-card ${skill.enabled ? "enabled" : "disabled"}`} key={skill.path}>
              <button type="button" role="switch" aria-checked={skill.enabled} aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} className={`mini-toggle ${skill.enabled ? "on" : ""}`} onClick={() => onToggle(skill.path)}><span /></button>
              <span className="skill-card-mark"><Boxes size={15} /></span>
              <div className="skill-card-copy">
                {editingPath === skill.path ? (
                  <form className="skill-name-editor" onSubmit={(event) => { event.preventDefault(); if (onRename(skill.path, nameDraft)) setEditingPath(null); }}>
                    <span>$</span><input autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} aria-label={`Invocation name for ${skill.fileName}`} />
                    <button type="submit" aria-label="Save skill name"><Check size={12} /></button>
                    <button type="button" onClick={() => setEditingPath(null)} aria-label="Cancel skill rename"><X size={12} /></button>
                  </form>
                ) : (
                  <div className="skill-name-row"><strong>${skill.name}</strong><button onClick={() => { setEditingPath(skill.path); setNameDraft(skill.name); }} aria-label={`Rename ${skill.name}`} title="Change app-only invocation name"><Pencil size={11} /></button></div>
                )}
                <p>{skill.description}</p>
                <small>{skill.relativePath}{skill.supportingMarkdownCount ? ` · ${skill.supportingMarkdownCount} supporting Markdown file${skill.supportingMarkdownCount === 1 ? "" : "s"}` : ""}</small>
              </div>
              <button className="skill-reveal-button" onClick={() => void revealItemInDir(skill.path)} title="Show source file"><FolderOpen size={13} /></button>
            </div>
          ))}
          {!busy && !filtered.length && <div className="skill-empty-state"><Boxes size={22} /><strong>{skills.length ? "No matching skills" : "No skills found yet"}</strong><small>Add a top-level Markdown file to this folder, import one, or create your first skill below.</small></div>}
        </div>

        <div className="skill-create-card">
          <div><span className="skill-create-icon"><Plus size={15} /></span><span><strong>Create a Markdown skill</strong><small>OpenKiwi creates the file in your selected folder. You can edit it in any Markdown editor afterward.</small></span></div>
          <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Skill name, for example: release-check" />
          <textarea value={createInstructions} onChange={(event) => setCreateInstructions(event.target.value)} rows={4} placeholder="Describe when to use this skill and the instructions the model should follow…" />
          <button className="primary-button" onClick={() => void create()} disabled={creating || !createName.trim() || !createInstructions.trim()}>{creating ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} Create skill</button>
        </div>

        <div className="skill-reference-note"><Check size={13} /><span><strong>Referenced Markdown works</strong><small>Relative `.md` references are mirrored with the skill when OpenKiwi prepares it for the model. Source files are never rewritten.</small></span></div>
      </>}
      {error && <div className="manager-status error">{error}</div>}
    </section>
  );
}
