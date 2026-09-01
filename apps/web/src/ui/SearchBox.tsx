import { useMemo, useState } from "react";
import type { SearchResult, TransitNetwork } from "@japan-live/transit";

interface Props {
  network: TransitNetwork | null;
  onPick: (result: SearchResult) => void;
}

/** Station and line search (spec §56). Selecting a result flies the camera to it. */
export function SearchBox({ network, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);

  const results = useMemo<SearchResult[]>(() => {
    if (!network || query.trim().length === 0) return [];
    return network.search(query, 10);
  }, [network, query]);

  return (
    <div className="search">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 160)}
        placeholder="駅・路線を検索"
        aria-label="駅・路線を検索"
        spellCheck={false}
      />
      {focused && results.length > 0 && (
        <div className="panel search-results">
          {results.map((r) => (
            <button
              key={`${r.kind}:${r.id}`}
              className="search-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(r);
                setQuery("");
                setFocused(false);
              }}
            >
              {r.name}
              <span className="kind">{r.kind === "station" ? "駅" : r.subtitle ?? "路線"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
