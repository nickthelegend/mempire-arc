#!/usr/bin/env python3
"""Emits `TICKER<TAB>PROMPT` for the cards named on argv, or all of them."""
import json
import os
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The catalogue lives inside the app because it is runtime data: the Cards
# filter reads it. Vercel roots the deployment at app/, so anything the
# bundle imports from outside that directory is simply not uploaded.
data = json.load(open(os.path.join(root, 'app', 'src', 'data', 'cards.json')))
want = {a.upper() for a in sys.argv[1:]}
for c in data['cards']:
    if want and c['ticker'].upper() not in want:
        continue
    prompt = ("A cute chibi mascot character for %s: %s. %s. %s palette. "
              "Flat pure magenta #FF00FF background."
              % (c['name'], c['desc'], data['style'], c['palette']))
    sys.stdout.write("%s\t%s\n" % (c['ticker'], prompt))
