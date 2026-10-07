# Design brief — Mempire launch post #1 (X / Twitter)

Make one **1600 × 900 PNG** (16:9) to attach to an X post. It is the first
public image this project has ever shipped, so it has one job: someone
scrolling a timeline stops, understands in a second that this is a Clash
Royale-style battler whose fighters are coins, stocks and crypto, and clocks
that it is built on Solana with MagicBlock.

Do not invent metrics, user counts, testimonials, partner logos, or exchange
listings. Nothing on this image may claim something that is not true.

**One claim is now false and must never appear, in art or in copy: that the game
touches a player's holdings.** It does not custody, lock or stake anyone's
tokens — that whole subsystem is gone from the program. A ticker is a character
on your roster, not collateral, and you never have to hold the coin to play it.
So: no vault, no padlock over a token, no wallet balance turning into card
power, no "your bags", no "the coins in your wallet". The only thing a player
ever puts up is the SOL they choose to wager on a match, and levels are won,
never bought. Post #2 carries the same ban — the two images have to be telling
the same story.

---

## The world it has to live in

Mempire looks like Clash Royale with a Solana wallet. Everything below is
already built and shipping — match it exactly rather than reinterpreting it.

**Palette** (copy these hexes, do not substitute):

| role | hex |
|---|---|
| field, deep | `#0d2a5c` |
| field, base | `#14418f` |
| field, lit | `#2160c4` |
| field, pale | `#59a6f5` |
| wood | `#7a4a22` |
| wood highlight | `#b9793c` |
| wood edge | `#2e1908` |
| gold | `#ffc422` |
| gold, high | `#ffe38a` |
| gold, deep | `#a8730a` |
| Solana purple | `#9945ff` |
| Solana teal | `#14f195` |
| elixir magenta | `#d838d8` |
| ink (every outline) | `#10203f` |

**Rules of the world, all load-bearing:**

- **The field is a quilt.** Royal blue with a diamond harlequin pattern at 46px,
  lit from the top centre, falling off to `#0d2a5c` at the edges.
- **Gold means SOL is moving.** Never use gold as decoration. It marks money and
  the primary action, nothing else.
- **Everything is carved.** Panels sit on a hard base edge and cast a real
  shadow. Nothing floats flat on the field.
- **Every shape is outlined in ink** (`#10203f`), 3–4px, including type.
- **Display type** is Lilita One, uppercase, with a heavy dark stroke
  (~0.085em) painted *under* the fill, plus an offset shadow
  `0 0.055em 0 rgba(0,0,0,.5)`. That stroke-under-fill is what makes it read as
  arcade lettering rather than a bold web font. Body copy is Nunito.

---

## Assets — use these, do not generate new characters

Everything is on disk. The characters are the product; drawing new ones would
put art in the post that does not exist in the game.

### Fighter art — 64 characters, background already removed

**PNG with real transparency (use these for compositing):**
```
/Volumes/Extreme SSD/Projects/mempire-landing/public/og/card_<ticker>.png
```
400 × 530, RGBA. 64 files. Tickers are lowercase.

**WebP equivalents** (same art, if your tool prefers them):
```
/Volumes/Extreme SSD/Projects/mempire-landing/public/cards/card_<ticker>.webp
```

**Suggested cast for this image** — the most recognisable, and a spread across
coins, stocks and crypto:
`card_btc.png` (gold knight, the hero), `card_pepe.png` (trenchcoat frog),
`card_sol.png` (purple/teal cyber), `card_nvda.png`, `card_eth.png` (purple
mage), `card_bonk.png`, `card_popcat.png`.

Not all frogs and dogs. A line-up of seven memecoins sells a memecoin game,
which this is not — if any ticker on the image is legible, at least one of them
should be a stock.

The directory holds art for 64 tickers, which is more than the game ships.
**The playable roster is the 36 verified mainnet assets** in
`app/src/lib/mainnet-coins.json`, and every fighter on this image must come from
that list:

> btc eth sol bnb ada trx shib uni · **nvda meta intc hood mstr dis v** ·
> bonk popcat pnut fwog goat chillguy moodeng ai16z mew pepe brett mog ponke
> michi giga retardio slerf bome silly harambe wen

The seven in bold are tokenised stocks.

### Logo
```
/Volumes/Extreme SSD/Projects/mempire-landing/public/brand/logo.webp   (512×249, RGBA)
/Volumes/Extreme SSD/Projects/mempire-landing/public/og/logo.png       (240×117, RGBA)
```
Gold "MEMPIRE" wordmark under a crown, with purple/teal energy behind it. It is
the only wordmark — do not set the name in type.

### Wood texture (for any carved panel or banner)
```
/Volumes/Extreme SSD/Projects/mempire-landing/public/brand/wood.webp
/Volumes/Extreme SSD/Projects/mempire/app/public/art/wood_seamless.png
```

### Real screenshots of the running build
```
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/battle_hero.webp  (640×1205, the arena mid-match)
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/battle.webp
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/cards.webp
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/arena.webp
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/deck.webp
```
All portrait phone captures. If you use one, put it in a device frame — do not
crop a portrait to landscape.

### Supporting art
```
/Volumes/Extreme SSD/Projects/mempire/app/public/art/chest_golden.png
/Volumes/Extreme SSD/Projects/mempire/app/public/art/chest_legendary.png
/Volumes/Extreme SSD/Projects/mempire/app/public/art/chest_open.png
/Volumes/Extreme SSD/Projects/mempire/app/public/art/arena_ground.png
/Volumes/Extreme SSD/Projects/mempire/app/public/art/icon_tank.png   (also: swarm, ranged, splash, support, spell)
/Volumes/Extreme SSD/Projects/mempire/app/public/crown.svg
```

---

## Composition

A hero line-up. The fighters are the reason anyone stops scrolling, so they get
the space — this is a roster shot, not a feature grid.

- **Background:** the quilted royal-blue field, lit from top centre. Add a warm
  gold glow behind the character line-up so they separate from the quilt. Sink
  the corners.
- **Characters:** 5–7 fighters standing along the lower two thirds, overlapping
  slightly, largest at centre and stepping down in scale toward both edges.
  $BTC (the gold knight) centre and largest. Ground them — a soft contact shadow
  under each, or a strip of `arena_ground.png`. They must not look like stickers
  pasted on a gradient.
- **Logo:** upper centre or upper left, roughly 300–380px wide.
- **Headline:** in the upper third, Lilita One, ink stroke under fill:

  > **THE MARKET IS THE ROSTER**

- **Sub-line**, Nunito, `#b9d4f7`, one line:

  > Coins, stocks and crypto. You never have to hold one to play it.

- **Foot:** one carved wood banner, or a row of small pill chips, carrying:

  > `SOLANA` · `MAGICBLOCK` · `mempire.fun`

  Only `mempire.fun` is gold. Set MAGICBLOCK as plain type — do not draw their
  logo from memory or invent a mark for it.

Keep the middle breathable. A busy quilt plus 7 characters plus stacked
paragraphs will read as noise at timeline size.

## Check it at thumbnail size

X shows this at roughly 500px wide in a feed and smaller on a phone. Before you
call it done, look at it at 25% and confirm the headline is still readable and
you can still tell what the characters are. If the sub-line disappears, it is
too small — cut it rather than shrinking the headline to make room.

## Deliverable

`mempire-launch-1.png`, 1600 × 900, sRGB, under 5 MB.
