# Ascension: Type Omega

A Kardashev-scale strategy-tycoon. Climb from a campfire to Multiversal Mastery (Tier 5) while keeping your people together and outrunning AI rivals whose IQ evolves over time.

## Play (Vercel)

- `public/index.html` is the browser UI (no external CDNs).
- `api/game.py` is a FastAPI serverless function: `POST /api/game` with an `action` (`new`, `load`, `step`, `research`, `address`, `allocate`).
- The server is stateless: the browser keeps the game state (saved in `localStorage`) and sends it with every request.
- `ascension.py` is the game engine. `vercel.json` bundles it into the function.

Deploy: import the repo in Vercel. No build step or env vars needed.

## Play (terminal)

```
python3 ascension.py            # random run
python3 ascension.py --seed 7   # reproducible run
```

## Mechanics

- **Energy economy:** Watts and WPS. Tier is recalculated every tick from current WPS (Tier 1 at 1 kW/s up to Tier 5 at 100 GW/s).
- **Budget:** split output between Comfort, Research and Conquest. Underfunding comfort or over-allocating to research/conquest drops Cohesion.
- **Factions:** Luddites, Outer-World Rebels, Timeline Purists. Low Cohesion triggers hoarding, strikes (WPS halved) and Civil War (WPS x0.25) until you pay to resolve it.
- **Tech tree:** 12 techs in a dependency chain, Primitive Fire to Multiversal Lattice.
- **Achievements:** permanent, compounding WPS multipliers.
- **Rivals:** four AI civilizations with different starting IQs. Their IQ grows over time; it drives how fast they compound output, how often they blunder, and how well they spy on you. First to Tier 5 wins.

A near-perfect run takes roughly 270 ticks; the smartest rival finishes around 300.
