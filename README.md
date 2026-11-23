[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/hakeno337/fast-sitegen/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/hakeno337/fast-sitegen/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# fast-sitegen

A faster drop-in for makefun-site 1.0.0, entered in make.fun's
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty. `solve.js` exports `run(input)`, which returns exactly the output tree makefun-site 1.0.0's
build returns for the same site — front matter, Markdown subset, template dialect, slug rule,
collections, tags and build report, byte for byte — and `main.ts` is the harness driver that
reads `/input/cases.json` and writes `/output/answers.json`.

Where the speed comes from: lexing and rendering Markdown are fused into one pass with bulk
HTML escaping and a fast path for text without specials; templates are compiled once and
rendered into a single buffer; slugify results are memoised per build (titles, tags and
headings repeat constantly); link resolutions that do not depend on the linking source are
cached; each post's card is built once and shared by its page, the index pages and the tag
pages.

## Run it

    node main.ts    # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR, or /input and /output

Node 22.18 or later, no dependencies.
