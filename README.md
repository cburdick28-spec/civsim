# Ascension: Type Omega

A Kardashev-scale strategy-tycoon. Climb from a campfire to Multiversal Mastery (Tier 5) while keeping your people together and outrunning AI rivals whose IQ evolves over time.

## Play (Vercel)

- `public/index.html` is the browser UI (no external CDNs).
- `api/game.py` is a FastAPI serverless function: `POST /api/game` with an `action` (`new`, `load`, `step`, `research`, `address`, `allocate`, `invest`).
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
- **Tech tree:** 12 techs in a dependency chain, Primitive Fire to Multiversal Lattice. Each tech also boosts one industry.
- **Industries:** five sectors that improve at different natural speeds (Computation fast, Biosphere slow). Extraction raises WPS, Computation raises research yield, Fabrication cuts tech costs, Biosphere lowers the comfort you need, Counter-Intelligence blunts rival attacks. Spend Watts to invest in any of them. Strikes and civil war slow all growth.
- **Achievements:** permanent, compounding WPS multipliers.
- **Rivals:** four AI civilizations with different starting IQs that grow over time. IQ drives how fast they compound output, how often they blunder, and how hard they hit a disunited civilization. First to Tier 5 wins. Each has a specialty:
  - **Vael Collective** (Computation): IQ grows 35% faster; cyber attacks drain your research fund.
  - **Orion Hegemony** (Extraction): 12% faster output growth; blockades knock down your Extraction industry.
  - **Nyx Syndicate** (Espionage): attacks twice as often and steals more Watts, but grows slower.
  - **Aurelian Concord** (Biosphere): pacifist and rarely blunders; offers trade pacts that help you both.

A near-perfect run takes roughly 270 ticks; the smartest rival finishes around 315, so sloppy play loses the race.
