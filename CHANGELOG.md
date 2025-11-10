# Changelog

## [Unreleased]

### Added

## [0.4.1] - 2025-11-08

### Added

- Truncate choice text to 60 chars for graph display (or 7 wrapped 12-char lines)
- Make graph passage names with `.` in them ALSO wrap/break on underscores `_` if the underscore part of the name is too long
- Parse parameterized passages in graph view
- Make graph view UI (legend, stats, export buttons) more minimal and smaller with expanded stats count titles on hover.

## [0.4.0] - 2025-11-08

### Added

- **New Snippets:**
  - `ifel` - If-else block (no elif)
  - `br` - Section divider comment with dashes
  - `bigbr` - Major section divider comment with equals signs

## [0.3.0] - 2025-11-08

### Added

- **Interactive Story Graph Visualization**: View your entire story structure as a visual graph
- **Click to Jump**: Click any passage node to jump to that passage in your code
- **Color-Coded Edges**:
  - Purple solid lines for regular choices
  - Orange dashed lines for conditional choices
  - Gold thick lines for direct jumps
- **Missing Passage Detection**: Red nodes highlight passages that are referenced but don't exist (typos/bugs)
- **Orphan Passage Detection**: Cyan borders on passages that nothing points to (dead code)
- **Export Graph**: Save your story graph as PNG or SVG
- **Story Stats**: See passage count, choice count, missing passages, and orphans at a glance
- **Auto-Refresh**: Graph updates automatically when you save your .bard file
- **Legend**: Visual guide explaining all the colors and symbols

### Improved

- Word-wrapped node labels for better readability
- Horizontal edge labels (always readable)
- Hierarchical auto-layout

## 0.2.1 - 2025-11-07

## Fixed

- Fixed choice pattern matching ending bug
- Set `.bard` files to automatically word wrap

## 0.2.0 - 2025-11-07

### Added

- Inline conditionals
- Nested expressions inside inline conditionals
- Inline conditionals (and nested expressions) in choice text

### Fixed

- Apostrophes in {} being treated as the start of Python strings

## 0.1.0

### Added

- Initial release
