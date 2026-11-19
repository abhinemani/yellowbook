# Design: the Sovra look

The app uses the same visual style as the owner's Sovra work. Tokens live in `design/tokens.css`; this page explains how to use them. It is a visual style only; it contains no Sovra data.

## Palette

| Token | Hex | Use |
|---|---|---|
| `--navy` | `#14213D` | Dominant. Sidebar, top bar, hero/summary areas, primary buttons. |
| `--maroon` | `#7A1F2B` | Emphasis, icon circles, "needs attention" accents. |
| `--rose` | `#D06470` | Highlights **on navy only**: links, active nav, key numbers. |
| `--steel` | `#8DA2C0` | Secondary text and fills; text on navy. |
| `--tint` | `#EEF1F6` | Light page and section background. |
| `--slate` | `#5A6478` | Body text on light backgrounds. |

Lean heavily on navy. Data-dense screens (tables, the review queue) sit on white or tint panels inside the navy frame.

## Type

Open Sans only. Thin and sharp, not wide or heavy. **Open Sans Light** for headlines and big numbers; **Regular/Bold** for body and labels. No serifs, no heavy display faces.

## Layout and components

- Structured layouts with **line icons in colored circles** (maroon or navy circle, white 1.5px-stroke icon). No stock imagery.
- Never draw boxes stacked as ladders, funnels or pyramids.
- Titles are short, one line, plain claims that make sense to someone who does not know the business ("23 contacts changed", not "Delta analysis").
- Bullets are left-aligned, with a bolded lead phrase followed by a sentence or two.
- Polished and concise: trim copy.
- **Status chips** (text label always shown, never color alone): Confirmed (navy on pale blue), Replaced (maroon on pale rose), Role mismatch (maroon on lighter rose), Vacant/interim and Unclear (slate on grey-blue), Unable to confirm (outlined), Not checked (dashed outline).
- Accessibility: body text contrast at least 4.5:1; focus rings visible on navy and white; keyboard-operable tables and queue.

## Screens

1. **Overview.** Big Light-weight numbers on navy: seats checked, confirmed, replaced, awaiting review, due for re-check. One line of explanation under each.
2. **Agencies.** Search box (name, state), filters (category, population, state). Result table with seat chips per role. "Add agency" opens the lookup flow: type a name, see candidates with sources, confirm, choose roles.
3. **Agency detail.** Header on navy (name, category, population, website). Grid of seats: role, current contact, last check, status chip, source link. "Verify this agency" and "Add a seat".
4. **Verify.** Scope builder (roles, states, population floor, last checked before), a cost and count estimate shown before starting, then live progress and retry-unresolved.
5. **Review queue.** Side by side: listed contact vs found contact, evidence date, confidence, source link opened in a new tab. Accept, reject, edit. Keyboard shortcuts for speed.
6. **Roles.** The role registry: label, definition, title hints. Add a custom role.
7. **Import / Export.** Drop a Power Almanac CSV; export with the check columns.
