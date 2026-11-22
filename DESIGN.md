# Design

The board page uses one warm, quiet theme defined in `src/ui/style.css`. Block-specific styles are in `src/ui/blocks.css`, `src/ui/annotate.css` and `src/ui/a2ui.css`.

## Color
Light: canvas `#fcfbf9`, sunken `#f6f4f0`, card `#ffffff`, ink `#1c1b19`, secondary ink `#57534e`, muted `#8a8580`, border `#ece9e4`. One accent, terracotta `#c2674b` (hover `#b25a40`, soft tint `#f5e9e3`). Danger `#bc4434`, ok `#4d8a66`.
Dark: canvas `#201e1c`, card `#282624`, ink `#edeae4`, accent `#d08159`. Dark follows `prefers-color-scheme` unless `data-theme` is set.

## Type
Display text uses the system serif stack (`ui-serif`, Iowan Old Style, Georgia). Body text uses the system sans stack.

## Surfaces
Cards use soft warm shadows (`--shadow-card`, `--shadow-lift`) and hairline borders instead of heavy outlines. Motion uses `cubic-bezier(0.4, 0, 0.2, 1)`.

## Rules
- One accent color per board.
- Dark mode keeps the warm graphite hue, not a blue-black.
- Unknown: no documented spacing scale or component inventory beyond what the CSS files define.
