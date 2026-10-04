type SelectKeyAction = { kind: 'highlight' | 'submit'; index: number };

// Space submits the highlighted option like Enter does, instead of natively
// clicking whichever option button happens to hold focus.
export const resolveSelectKeyAction = (
  key: string,
  highlightedIndex: number,
  optionCount: number,
): SelectKeyAction | null => {
  if (optionCount <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return { kind: 'highlight', index: (highlightedIndex + 1) % optionCount };
    case 'ArrowUp':
      return { kind: 'highlight', index: (highlightedIndex - 1 + optionCount) % optionCount };
    case 'Home':
      return { kind: 'highlight', index: 0 };
    case 'End':
      return { kind: 'highlight', index: optionCount - 1 };
    case 'Enter':
    case ' ':
      return { kind: 'submit', index: highlightedIndex };
    default: {
      if (key.length !== 1 || key < '1' || key > '9') return null;
      const index = Number(key) - 1;
      return index < optionCount ? { kind: 'submit', index } : null;
    }
  }
};
