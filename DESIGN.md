# Context War visual system

## Design intent
Context War should feel like an editorial instrument, not a startup template. The visual reference is a well-typeset newspaper front page crossed with a live terminal status board: precise, sparse, tense. Black and off-white only. The interface earns drama through scale, density, rules and changing numbers rather than color, illustration or effects.

## Typography
- Display: system grotesk stack `Arial, Helvetica, sans-serif`, 800 weight, -0.055em tracking. Hero ranges from 76px desktop to 44px mobile. No fashionable imported font dependency and no ornamental alternates.
- Reading text: Georgia, Times, serif for the AI diary and long explanatory lines. It separates machine output from interface copy without pretending to be handwriting.
- UI/meta: system sans, 11–13px, uppercase only for structural labels, 0.08em tracking. Do not uppercase full sentences.
- Numbers: tabular lining figures. Large memory percentage and shield counts align cleanly.

## Grid and spacing
- Page max width 1440px; 24px desktop gutters, 16px mobile.
- 12-column desktop grid. Primary memory field spans 8 columns; status rail spans 4. At <=860px, stack without changing reading order.
- 8px base spacing. Major section breaks: 64–96px desktop, 48px mobile. Component gaps: 12–24px.
- Use 1px black rules to create hierarchy. Avoid container backgrounds and card shadows.

## Hierarchy
1. Masthead with product name, live status and current cycle.
2. Huge proposition, current memory pressure and one primary action.
3. Memory ledger: the actual product, visible before explanation.
4. Diary: consequence of the current memory.
5. Rules and provenance.

## Components
- Masthead: thin top/bottom rules, left wordmark, right cycle status. No nav pill.
- Capacity meter: a hard rectangular track, black fill, exact `used / 1000 tokens` label. Never a circular gauge.
- Memory row: rank, belief, author alias, token weight, shields and time-to-decay. White canvas, 1px bottom border. Hover only inverts the action label. A protected row gets a 4px left rule, not a badge.
- Add belief drawer: inline expansion beneath the hero, not a modal. Textarea with character counter, alias, checkbox acknowledging public visibility, and a rectangular submit button.
- Protect action: one clear text button. Confirmation is an inline sentence. Never confetti.
- Eviction event: struck text stays visible for one cycle with a timestamp and terse reason.
- Diary: oversized serif paragraph with a dateline, generation status and cited memory numbers. Share control exports a black-on-white image.
- Payment surface: disabled preview until seller terms are connected. It must say free launch mode plainly. No fake checkout or fake urgency.
- Toast/state: bottom-left plain bordered note, max two lines. Errors remain beside the control.

## States
- Empty: one sentence explaining that the first belief will define the AI; no illustration.
- Loading: preserve layout, use three static hairline placeholders. No shimmering skeleton.
- Success: update ledger immediately, briefly underline the changed row for 600ms.
- Error: black 2px outline and direct copy describing what failed.
- Full memory: meter reads 100%; adding a belief previews exactly which weak memory will be displaced.
- Diary pending: show scheduled UTC time, never pretend generation is live.
- Payment unavailable: state `Free launch mode. Paid moves are not active.`

## Motion
- Default duration 120–180ms, ease-out.
- Only motion with meaning: drawer opens, meter changes, row reorders, changed row underline fades.
- Respect `prefers-reduced-motion`; remove all transitions.
- No entrance choreography, parallax, floating shapes, cursor effects or animated backgrounds.

## Responsive behavior
- Desktop: split ledger/status rail; sticky status rail only when viewport height permits.
- Tablet/mobile: one column, masthead wraps, hero remains left aligned, row metadata wraps beneath belief. Tap targets >=44px.
- At 360px: no horizontal scroll, no clipped numbers, share image control full width.
- Diary retains 30–38px type on mobile with comfortable 1.18 line height.

## Copy voice
Short, literal, slightly severe. `Add a belief.` `Memory is full.` `Belief 04 will disappear.` Explain mechanics before metaphor. No `revolutionize`, `unlock`, `supercharge`, `seamless`, `powered by AI`, or breathless punctuation. Never call users creators, visionaries or a community. No fake social proof or invented counters.

## Explicit anti-patterns
No gradients, purple, glow, glass, blur panels, blob backgrounds, random pills, excessive rounded corners, shadows, stock images, 3D mascots, emoji decoration, logo clouds, testimonial carousel, generic three-feature grid, fake metrics, infinite ticker, centered-everything composition, equal-sized card grids, gratuitous animation, giant footer sitemap, or AI-generated abstract art. Do not add explanatory copy merely to fill whitespace. Do not make every section symmetrical. The live state is the visual content.
