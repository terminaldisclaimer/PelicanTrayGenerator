# Example part outlines

Sample SVGs for trying the app out. They cover the shapes and unit conventions
the parser has to deal with in practice.

| File | Shape | Notes |
|---|---|---|
| `lens-plate.svg` | 120 x 80 mm rounded rectangle | `rect` with `rx`/`ry` |
| `round-window.svg` | 90 mm circle | `circle` |
| `oval-mirror.svg` | 90 x 50 mm ellipse | viewBox in 96 dpi units against a mm `width`/`height`, the Shaper Origin convention |
| `prism-block.svg` | 60 mm triangle | `path` with straight segments |
| `vial.svg` | 22 mm circle | small part, good for testing quantities |
| `ring-mount.svg` | 80 mm ring, 30 mm bore | tick **Holes** to leave the bore as a raised island in the pocket |
| `bracket.svg` | 100 x 40 mm L-shape | non-convex outline, exercises minimum-area rotation |

Suggested depths to start with: 12, 8, 6, 45, 30, 18, 22 mm.
