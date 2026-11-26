"use client";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { LEVEL_IDS, isLevelId, levelById, type LevelId } from "@/services/players/levels";
import {
  isNameIndex,
  suggest,
  suggestionHref,
  type NameIndex,
  type Suggestion,
} from "@/services/search/name-index";
import { QUERY_MAX_LENGTH } from "@/services/players/directory-query";

/**
 * The header search input as an ARIA 1.2 combobox (T-205). Without JavaScript (or before the index
 * arrives) it is the plain `q` field of the header's GET form to /players. With JavaScript, the
 * first focus fetches the name index of the level in the URL (`?level=`), or of every level when
 * the page has none, once per level per page session; typing then matches locally (no request
 * per keystroke). Enter on a highlighted suggestion opens that player; Enter otherwise submits the
 * form as before.
 */
const indexes = new Map<LevelId, Promise<NameIndex | null>>();

function loadIndex(level: LevelId): Promise<NameIndex | null> {
  let p = indexes.get(level);
  if (!p) {
    p = fetch(`/search/names?level=${level}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: unknown) => (isNameIndex(v, level) ? v : null))
      .catch(() => null);
    // A failed load (level not loaded, network) may be retried on a later focus.
    p.then((v) => v ?? indexes.delete(level));
    indexes.set(level, p);
  }
  return p;
}

function scopeLevels(): LevelId[] {
  const level = new URLSearchParams(window.location.search).get("level") ?? "";
  return isLevelId(level) ? [level] : LEVEL_IDS;
}

export function PlayerTypeahead() {
  const router = useRouter();
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState<NameIndex[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const scope = useRef<string>("");

  const suggestions: Suggestion[] = loaded ? suggest(loaded, value) : [];
  const expanded = open && suggestions.length > 0;

  const ensureLoaded = () => {
    const levels = scopeLevels();
    const key = levels.join(",");
    if (scope.current === key) return;
    scope.current = key;
    void Promise.all(levels.map(loadIndex)).then((all) => {
      if (scope.current !== key) return;
      const ok = all.filter((x): x is NameIndex => x !== null);
      setLoaded(ok);
      // Let a later focus retry levels that failed to load.
      if (ok.length < levels.length) scope.current = "";
    });
  };

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const pick = (s: Suggestion) => {
    close();
    setValue(s.name);
    router.push(suggestionHref(s));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = suggestions.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!n) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (!open || a < 0 ? (step > 0 ? 0 : n - 1) : (a + step + n) % n));
    } else if (e.key === "Enter") {
      if (expanded && active >= 0 && active < n) {
        e.preventDefault();
        pick(suggestions[active]);
      }
    } else if (e.key === "Escape") {
      if (expanded) {
        e.preventDefault();
        close();
      } else if (value) {
        e.preventDefault();
        setValue("");
      }
    }
  };

  const meta = (s: Suggestion) =>
    [s.position, s.team ? (s.org && s.org !== s.team ? `${s.team} (${s.org})` : s.team) : null, levelById(s.level).short]
      .filter(Boolean)
      .join(" · ");

  return (
    <span className="typeahead">
      <input
        name="q"
        role="combobox"
        aria-label="Search players, teams or organizations"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={QUERY_MAX_LENGTH}
        placeholder="Search players, teams, orgs"
        value={value}
        onFocus={() => {
          ensureLoaded();
          setOpen(true);
        }}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <ul id={listId} role="listbox" aria-label="Player suggestions" className="typeahead-list" hidden={!expanded}>
        {expanded &&
          suggestions.map((s, i) => (
            <li
              key={`${s.level}-${s.key}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : undefined}
              // Keep focus in the input; the click picks.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(s)}
            >
              <span className="typeahead-name">{s.name}</span>
              <span className="typeahead-meta">{meta(s)}</span>
            </li>
          ))}
      </ul>
      <span className="sr-only" aria-live="polite">
        {expanded ? `${suggestions.length} player suggestion${suggestions.length === 1 ? "" : "s"}` : ""}
      </span>
    </span>
  );
}
