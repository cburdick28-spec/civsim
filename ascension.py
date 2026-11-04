#!/usr/bin/env python3
"""
Ascension: Type Omega
=====================
A Kardashev-scale strategy-tycoon simulation with an interactive CLI.

Systems
-------
1. Passive energy economy (Watts / Watts-Per-Second) and dynamic Civilization Tier (0-5).
2. Population "Free Will" + Cohesion, with ideological Factions that hoard, strike,
   or trigger a Civil War when Cohesion collapses.
3. Node-based TechTree with dependency validation + tick-driven AchievementManager
   that grants permanent, compounding WPS multipliers.
4. Simulation loop + interactive terminal UI.

Run:
    python3 ascension.py            # random run
    python3 ascension.py --seed 7   # reproducible run

Pure standard library. Python 3.8+.
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

TICK_SECONDS = 60            # simulated seconds that pass per tick
STARTING_WPS = 10.0          # baseline civilization output before any tech
MAX_BATCH_TICKS = 100        # cap for "1 N" batch stepping in the CLI
CONQUEST_BONUS_CAP = 1.0     # conquest can add at most +100% WPS
OVERREACH_LIMIT = 55         # research% + conquest% above this hurts Cohesion
RIVAL_BASE_GROWTH = 0.047    # per-tick compound WPS growth of an IQ-100 rival
TECH_COST_FACTORS = [45, 180, 360, 540, 720, 540]   # cost = wps_bonus * factor[tier]
UNIT_LABELS = ["W", "kW", "MW", "GW", "TW", "PW", "EW", "ZW", "YW"]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def fmt_watts(value: float, per_second: bool = False) -> str:
    """Format a wattage with an SI prefix, e.g. 1.50 MW (or MW/s for WPS)."""
    magnitude = value
    idx = 0
    while abs(magnitude) >= 1000.0 and idx < len(UNIT_LABELS) - 1:
        magnitude /= 1000.0
        idx += 1
    suffix = "/s" if per_second else ""
    return f"{magnitude:,.2f} {UNIT_LABELS[idx]}{suffix}"


def bar(value: float, width: int = 20, maximum: float = 100.0) -> str:
    filled = int(round(clamp(value / maximum, 0.0, 1.0) * width))
    return "[" + "#" * filled + "-" * (width - filled) + "]"


# --------------------------------------------------------------------------- #
# Kardashev tiers
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class TierInfo:
    level: int
    name: str
    wps_threshold: float


TIERS: List[TierInfo] = [
    TierInfo(0, "Planetary Sub-Type", 0.0),
    TierInfo(1, "Planetary Mastery", 1e3),
    TierInfo(2, "Stellar Mastery (Dyson Spheres)", 1e5),
    TierInfo(3, "Galactic Mastery (Black Holes)", 1e7),
    TierInfo(4, "Universal Mastery", 1e9),
    TierInfo(5, "Multiversal Mastery", 1e11),
]


def tier_for_wps(wps: float) -> TierInfo:
    """Return the highest tier whose WPS threshold has been met."""
    current = TIERS[0]
    for tier in TIERS:
        if wps >= tier.wps_threshold:
            current = tier
    return current


# --------------------------------------------------------------------------- #
# Budget allocation
# --------------------------------------------------------------------------- #

@dataclass
class Allocation:
    """How gross output is split each tick (percentages)."""
    comfort: int = 30
    research: int = 30
    conquest: int = 10

    @property
    def reserve(self) -> int:
        return 100 - self.comfort - self.research - self.conquest

    @staticmethod
    def required_comfort(tier_level: int) -> int:
        """Civilian comfort expectations rise as the civilization grows."""
        return 20 + 4 * tier_level

    def is_valid(self) -> bool:
        parts = (self.comfort, self.research, self.conquest)
        return all(0 <= p <= 100 for p in parts) and sum(parts) <= 100


# --------------------------------------------------------------------------- #
# Factions
# --------------------------------------------------------------------------- #

class EventType(Enum):
    HOARDING = "Hoarding"
    STRIKE = "Strike"
    CIVIL_WAR = "Civil War"


@dataclass
class Faction:
    name: str
    description: str
    grievance: Callable[["Game"], float]   # influence gained per tick
    influence: float = 10.0                # 0-100
    hoard: float = 0.0                     # Watts stolen from the treasury
    strike_ticks: int = 0                  # remaining strike duration
    civil_war: bool = False

    @property
    def hoarding(self) -> bool:
        return self.hoard > 0.0

    @property
    def striking(self) -> bool:
        return self.strike_ticks > 0

    @property
    def active(self) -> bool:
        return self.hoarding or self.striking or self.civil_war

    def status_text(self) -> str:
        tags: List[str] = []
        if self.civil_war:
            tags.append("CIVIL WAR")
        if self.striking:
            tags.append(f"STRIKE {self.strike_ticks}t")
        if self.hoarding:
            tags.append(f"HOARDING {fmt_watts(self.hoard)}")
        return ", ".join(tags) if tags else "quiet"

    def update_influence(self, game: "Game") -> None:
        decay = 0.8 + game.allocation.comfort * 0.02
        self.influence = clamp(self.influence + self.grievance(game) - decay, 0.0, 100.0)


def _luddite_grievance(game: "Game") -> float:
    return game.allocation.research * 0.05 + game.techtree.researched_count() * 0.25


def _rebel_grievance(game: "Game") -> float:
    gap = max(0, Allocation.required_comfort(game.tier.level) - game.allocation.comfort)
    return game.allocation.conquest * 0.12 + gap * 0.15


def _purist_grievance(game: "Game") -> float:
    deep_techs = sum(1 for n in game.techtree.nodes.values() if n.researched and n.tier >= 4)
    return game.highest_tier * 0.4 + deep_techs * 1.5 + game.population.free_will * 0.01


def build_factions() -> List[Faction]:
    return [
        Faction("Luddites", "Distrust runaway technology; resent research spending.", _luddite_grievance),
        Faction("Outer-World Rebels", "Colonies that resent conquest and civilian neglect.", _rebel_grievance),
        Faction("Timeline Purists", "Believe tampering with spacetime is heresy.", _purist_grievance),
    ]


# --------------------------------------------------------------------------- #
# Population
# --------------------------------------------------------------------------- #

class Population:
    """Aggregate Free Will and the global Cohesion Score (both 0-100)."""

    def __init__(self) -> None:
        self.free_will: float = 50.0
        self.cohesion: float = 75.0
        self.high_cohesion_streak: int = 0

    def update(self, allocation: Allocation, tier_level: int, unrest_drag: float) -> None:
        required = Allocation.required_comfort(tier_level)
        deficit = max(0, required - allocation.comfort)
        surplus = max(0, allocation.comfort - required)
        overreach = max(0, allocation.research + allocation.conquest - OVERREACH_LIMIT)

        delta = 0.6                      # natural social healing
        delta -= deficit * 0.4           # underfunded civilian comfort
        delta -= overreach * 0.3         # over-allocation to tech/conquest
        delta += surplus * 0.05          # happy citizens
        delta -= unrest_drag             # active factions drag everyone down
        self.cohesion = clamp(self.cohesion + delta, 0.0, 100.0)

        # Free Will drifts toward a target: comfort liberates, conquest coerces.
        target = clamp(allocation.comfort * 1.6 - allocation.conquest * 1.5 + 10.0, 0.0, 100.0)
        self.free_will = clamp(self.free_will + (target - self.free_will) * 0.1, 0.0, 100.0)

        self.high_cohesion_streak = self.high_cohesion_streak + 1 if self.cohesion >= 80.0 else 0


# --------------------------------------------------------------------------- #
# Tech tree
# --------------------------------------------------------------------------- #

@dataclass
class TechNode:
    key: str
    name: str
    description: str
    cost: float
    wps_bonus: float
    tier: int
    prerequisites: List[str] = field(default_factory=list)
    researched: bool = False


class TechTreeError(Exception):
    """Raised when the tech tree definition is invalid."""


class TechTree:
    def __init__(self, nodes: List[TechNode]) -> None:
        self.nodes: Dict[str, TechNode] = {}
        for node in nodes:
            if node.key in self.nodes:
                raise TechTreeError(f"Duplicate tech key: {node.key}")
            self.nodes[node.key] = node
        self._validate()

    def _validate(self) -> None:
        for node in self.nodes.values():
            for req in node.prerequisites:
                if req not in self.nodes:
                    raise TechTreeError(f"{node.key} requires unknown tech '{req}'")
        # Cycle detection (DFS with colors).
        state: Dict[str, int] = {}

        def visit(key: str) -> None:
            if state.get(key) == 1:
                raise TechTreeError(f"Dependency cycle detected at '{key}'")
            if state.get(key) == 2:
                return
            state[key] = 1
            for req in self.nodes[key].prerequisites:
                visit(req)
            state[key] = 2

        for key in self.nodes:
            visit(key)

    def researched_count(self) -> int:
        return sum(1 for n in self.nodes.values() if n.researched)

    def all_researched(self) -> bool:
        return all(n.researched for n in self.nodes.values())

    def total_wps_bonus(self) -> float:
        return sum(n.wps_bonus for n in self.nodes.values() if n.researched)

    def missing_prerequisites(self, key: str) -> List[str]:
        return [r for r in self.nodes[key].prerequisites if not self.nodes[r].researched]

    def ordered(self) -> List[TechNode]:
        return list(self.nodes.values())

    def can_research(self, key: str) -> Tuple[bool, str]:
        if key not in self.nodes:
            return False, f"Unknown technology '{key}'."
        node = self.nodes[key]
        if node.researched:
            return False, f"{node.name} is already researched."
        missing = self.missing_prerequisites(key)
        if missing:
            names = ", ".join(self.nodes[m].name for m in missing)
            return False, f"{node.name} requires: {names}."
        return True, "ok"

    def mark_researched(self, key: str) -> None:
        self.nodes[key].researched = True


def build_tech_tree() -> TechTree:
    # (key, name, description, tier, wps_bonus, prerequisite)
    spec = [
        ("fire", "Primitive Fire", "Controlled combustion. The first spark of a civilization.", 0, 30.0, None),
        ("steam", "Steam & Coal", "Industry wakes up and burns the world's forests.", 0, 120.0, "fire"),
        ("grid", "Planetary Power Grid", "One continuous network wraps the globe.", 0, 600.0, "steam"),
        ("fusion", "Fusion Reactors", "Bottled stars power the whole planet.", 1, 3_000.0, "grid"),
        ("orbital", "Orbital Solar Arrays", "Mirrors in orbit beam sunlight home.", 1, 20_000.0, "fusion"),
        ("dyson", "Dyson Grid Blueprint", "Swarm collectors harvest a star's entire output.", 2, 150_000.0, "orbital"),
        ("swarm", "Dyson Swarm Expansion", "Billions of collectors dim the sun to a dull ember.", 2, 1_000_000.0, "dyson"),
        ("blackhole", "Black Hole Tap", "Feed on accretion disks and spin-down energy.", 3, 15_000_000.0, "swarm"),
        ("quasar", "Quasar Harvesting", "Ride a galactic core's jets like a power line.", 3, 100_000_000.0, "blackhole"),
        ("splicing", "Dimensional Splicing", "Stitch pockets of spacetime into one energy loop.", 4, 1_500_000_000.0, "quasar"),
        ("brane", "Brane Siphon", "Tap the vacuum between universes.", 4, 10_000_000_000.0, "splicing"),
        ("lattice", "Multiversal Lattice", "Draw power from neighboring realities.", 5, 300_000_000_000.0, "brane"),
    ]
    nodes: List[TechNode] = []
    for key, name, desc, tier, bonus, prereq in spec:
        cost = 100.0 if key == "fire" else bonus * TECH_COST_FACTORS[tier]
        nodes.append(TechNode(key, name, desc, cost=cost, wps_bonus=bonus, tier=tier,
                              prerequisites=[prereq] if prereq else []))
    return TechTree(nodes)


# --------------------------------------------------------------------------- #
# Achievements
# --------------------------------------------------------------------------- #

@dataclass
class Achievement:
    key: str
    name: str
    description: str
    multiplier: float                       # permanent WPS multiplier
    condition: Callable[["Game"], bool]
    unlocked: bool = False


class AchievementManager:
    def __init__(self, achievements: List[Achievement]) -> None:
        self.achievements = achievements

    @property
    def total_multiplier(self) -> float:
        total = 1.0
        for ach in self.achievements:
            if ach.unlocked:
                total *= ach.multiplier      # compounding
        return total

    def check(self, game: "Game") -> List[str]:
        """Evaluate every locked achievement; return unlock messages."""
        messages: List[str] = []
        for ach in self.achievements:
            if not ach.unlocked and ach.condition(game):
                ach.unlocked = True
                messages.append(
                    f"*** ACHIEVEMENT: {ach.name} - {ach.description} "
                    f"(permanent x{ach.multiplier:.2f} WPS) ***"
                )
        return messages


def build_achievements() -> AchievementManager:
    return AchievementManager([
        Achievement("spark", "Spark of Civilization", "Master fire.", 1.05,
                    lambda g: g.techtree.nodes["fire"].researched),
        Achievement("t1", "Planetary Mastery", "Reach Tier 1.", 1.25,
                    lambda g: g.highest_tier >= 1),
        Achievement("t2", "Stellar Mastery", "Reach Tier 2.", 1.50,
                    lambda g: g.highest_tier >= 2),
        Achievement("t3", "Galactic Mastery", "Reach Tier 3.", 1.75,
                    lambda g: g.highest_tier >= 3),
        Achievement("t4", "Universal Mastery", "Reach Tier 4.", 2.00,
                    lambda g: g.highest_tier >= 4),
        Achievement("t5", "Multiversal Mastery", "Reach Tier 5.", 2.50,
                    lambda g: g.highest_tier >= 5),
        Achievement("trailblazer", "Trailblazer", "Be the first civilization to reach Tier 3.", 1.25,
                    lambda g: g.highest_tier >= 3 and all(r.highest_tier < 3 for r in g.rivals)),
        Achievement("harmony", "Harmonious Society", "Hold Cohesion >= 80% for 15 ticks.", 1.20,
                    lambda g: g.population.high_cohesion_streak >= 15),
        Achievement("peace", "Peacemaker", "Resolve 3 faction crises.", 1.15,
                    lambda g: g.crises_resolved >= 3),
        Achievement("polymath", "Polymath", "Research every technology.", 1.50,
                    lambda g: g.techtree.all_researched()),
    ])


# --------------------------------------------------------------------------- #
# Rival AI civilizations
# --------------------------------------------------------------------------- #

IQ_LABELS: List[Tuple[float, str]] = [(85.0, "Dim"), (100.0, "Average"), (115.0, "Sharp"), (135.0, "Brilliant")]


def iq_label(iq: float) -> str:
    for limit, label in IQ_LABELS:
        if iq < limit:
            return label
    return "Genius"


class RivalCiv:
    """An AI civilization racing you to Tier 5.

    Its collective IQ evolves over time (steady learning plus rare breakthroughs).
    IQ drives how fast it compounds output, and how rarely it blunders.
    """

    def __init__(self, name: str, iq: float) -> None:
        self.name = name
        self.iq = iq
        self.start_iq = iq
        self.wps = STARTING_WPS
        self.highest_tier = 0
        self.blunders = 0
        self.ticks = 0
        self.iq_milestone = int(iq // 10)

    @property
    def tier(self) -> TierInfo:
        return tier_for_wps(self.wps)

    @property
    def label(self) -> str:
        return iq_label(self.iq)

    @property
    def progress(self) -> float:
        """0-1 progress toward Tier 5, on a log scale of output."""
        return clamp((math.log10(max(self.wps, 1.0)) - 1.0) / 10.0, 0.0, 1.0)

    def tick(self, rng: random.Random) -> List[str]:
        messages: List[str] = []
        self.ticks += 1

        # Development: steady learning, faster at higher tiers, plus rare insights.
        learn = 0.06 + 0.02 * self.tier.level
        if rng.random() < 0.008:
            learn += 3.0
        self.iq = clamp(self.iq + learn * rng.uniform(0.5, 1.5), 40.0, 200.0)

        # Growth scales with IQ; smart civs compound faster.
        quality = (self.iq / 100.0) ** 1.5 * rng.uniform(0.6, 1.4)
        self.wps = min(self.wps * (1.0 + RIVAL_BASE_GROWTH * quality), 1e14)

        # Low-IQ civs blunder more often.
        if rng.random() < (1.0 - self.iq / 200.0) * 0.05:
            self.wps *= 0.7
            self.blunders += 1
            messages.append(f"{self.name} (IQ {self.iq:.0f}) blunders and loses 30% of its output.")

        if self.tier.level > self.highest_tier:
            self.highest_tier = self.tier.level
            messages.append(f">> {self.name} ascends to Tier {self.highest_tier}: {self.tier.name}.")

        milestone = int(self.iq // 10)
        if milestone > self.iq_milestone:
            self.iq_milestone = milestone
            if milestone >= 12:
                messages.append(f"{self.name} breakthrough: collective IQ passes {milestone * 10}.")
        return messages


RIVAL_ROSTER: List[Tuple[str, float]] = [
    ("Vael Collective", 128.0),
    ("Orion Hegemony", 104.0),
    ("Nyx Syndicate", 92.0),
    ("Aurelian Concord", 72.0),
]


def build_rivals(rng: random.Random) -> List[RivalCiv]:
    """Each run jitters the roster's starting IQs so no two games match."""
    return [RivalCiv(name, clamp(iq + rng.uniform(-8.0, 8.0), 50.0, 150.0)) for name, iq in RIVAL_ROSTER]


# --------------------------------------------------------------------------- #
# Game engine
# --------------------------------------------------------------------------- #

class Game:
    def __init__(self, seed: Optional[int] = None) -> None:
        self.seed = seed if seed is not None else random.SystemRandom().randrange(1, 10**9)
        self.rng = random.Random(self.seed)
        self.rivals = build_rivals(self.rng)
        self.defeated_by: Optional[str] = None
        self.tick_count = 0
        self.watts = 0.0
        self.research_fund = 0.0
        self.conquest_bonus = 0.0
        self.highest_tier = 0
        self.crises_resolved = 0
        self.allocation = Allocation()
        self.population = Population()
        self.factions = build_factions()
        self.techtree = build_tech_tree()
        self.achievements = build_achievements()

    # ---- derived stats ---------------------------------------------------- #

    @property
    def raw_wps(self) -> float:
        return STARTING_WPS + self.techtree.total_wps_bonus()

    @property
    def multiplier(self) -> float:
        return self.achievements.total_multiplier * (1.0 + self.conquest_bonus)

    @property
    def potential_wps(self) -> float:
        """WPS before faction penalties."""
        return self.raw_wps * self.multiplier

    @property
    def civil_war_active(self) -> bool:
        return any(f.civil_war for f in self.factions)

    @property
    def strike_active(self) -> bool:
        return any(f.striking for f in self.factions)

    @property
    def penalty_modifier(self) -> float:
        if self.civil_war_active:
            return 0.25
        if self.strike_active:
            return 0.5
        return 1.0

    @property
    def wps(self) -> float:
        return self.potential_wps * self.penalty_modifier

    @property
    def tier(self) -> TierInfo:
        return tier_for_wps(self.wps)

    def unrest_drag(self) -> float:
        drag = 0.0
        for f in self.factions:
            drag += f.influence * 0.015
            if f.hoarding:
                drag += 0.8
            if f.striking:
                drag += 1.5
            if f.civil_war:
                drag += 4.0
        return drag

    # ---- simulation ------------------------------------------------------- #

    def step_tick(self) -> List[str]:
        if self.game_over:
            return ["The simulation has ended."]
        messages: List[str] = []
        self.tick_count += 1
        # Per-tick reseed keeps runs reproducible and lets a stateless server resume anywhere.
        self.rng = random.Random(self.seed * 100003 + self.tick_count)

        # 1. Economy: gross output split by allocation.
        gross = self.wps * TICK_SECONDS
        a = self.allocation
        self.watts += gross * a.reserve / 100.0
        self.research_fund += gross * a.research / 100.0
        self.conquest_bonus = min(CONQUEST_BONUS_CAP, self.conquest_bonus + a.conquest / 100.0 * 0.02)
        # (the comfort share is consumed by civilians; its effect is on Cohesion)

        # 2. Faction pressure and Population update.
        for f in self.factions:
            f.update_influence(self)
        self.population.update(a, self.tier.level, self.unrest_drag())

        # 3. Faction events.
        messages.extend(self._faction_events())

        # 4. Tier recalculation + achievements.
        previous_highest = self.highest_tier
        self.highest_tier = max(self.highest_tier, self.tier.level)
        if self.highest_tier > previous_highest:
            messages.append(f">>> Civilization ascends to Tier {self.highest_tier}: {tier_for_wps(self.wps).name}!")
        messages.extend(self.achievements.check(self))
        # Achievements may bump WPS enough to cross another tier; re-check once.
        if self.tier.level > self.highest_tier:
            self.highest_tier = self.tier.level
            messages.extend(self.achievements.check(self))

        # 5. Rivals develop, spy on you, and race for Tier 5.
        for rival in self.rivals:
            messages.extend(rival.tick(self.rng))
        messages.extend(self._rival_espionage())
        if self.defeated_by is None and not self.victory():
            for rival in self.rivals:
                if rival.highest_tier >= 5:
                    self.defeated_by = rival.name
                    messages.append(f"### DEFEAT: {rival.name} reached Multiversal Mastery first. ###")
                    break
        return messages

    def _rival_espionage(self) -> List[str]:
        """Smart rivals steal from disunited civilizations (low Cohesion = easy recruits)."""
        messages: List[str] = []
        for rival in self.rivals:
            if self.rng.random() >= 0.04 * (rival.iq / 100.0):
                continue
            success = rival.iq / 200.0 * (1.0 - self.population.cohesion / 150.0)
            if self.rng.random() < success and self.watts > 0.0:
                stolen = self.watts * self.rng.uniform(0.03, 0.06)
                self.watts -= stolen
                rival.wps *= 1.02
                messages.append(f"! ESPIONAGE: {rival.name} (IQ {rival.iq:.0f}) steals {fmt_watts(stolen)} and blueprints.")
            else:
                messages.append(f"{rival.name} espionage attempt foiled by a loyal population.")
        return messages

    def _faction_events(self) -> List[str]:
        messages: List[str] = []
        cohesion = self.population.cohesion

        # Expire strikes.
        for f in self.factions:
            if f.striking:
                f.strike_ticks -= 1
                if f.strike_ticks == 0:
                    messages.append(f"The {f.name} strike has fizzled out. Production resumes.")

        if cohesion >= 60.0:
            return messages

        severity = (60.0 - cohesion) / 60.0
        free_will_factor = 0.5 + self.population.free_will / 100.0
        for f in self.factions:
            if f.civil_war or f.striking:
                continue
            chance = min(0.6, severity * (0.3 + f.influence / 100.0) * free_will_factor * 0.8)
            if self.rng.random() >= chance:
                continue

            if cohesion < 15.0 and not self.civil_war_active:
                f.civil_war = True
                messages.append(
                    f"!!! CIVIL WAR: {f.name} take up arms! WPS slashed to 25%. "
                    f"Pay to end it (option 3)."
                )
            elif cohesion < 40.0 and self.rng.random() < 0.6:
                f.strike_ticks = self.rng.randint(4, 6)
                messages.append(
                    f"!! STRIKE: {f.name} walk off the grid for {f.strike_ticks} ticks. WPS halved."
                )
            elif self.watts > 0.0:
                stolen = self.watts * self.rng.uniform(0.08, 0.15)
                self.watts -= stolen
                f.hoard += stolen
                messages.append(f"! HOARDING: {f.name} siphon {fmt_watts(stolen)} into secret reserves.")
        return messages

    # ---- player actions --------------------------------------------------- #

    def research(self, key: str) -> Tuple[bool, str]:
        ok, reason = self.techtree.can_research(key)
        if not ok:
            return False, reason
        node = self.techtree.nodes[key]
        available = self.research_fund + self.watts
        if available < node.cost:
            return False, (f"Not enough energy for {node.name}: need {fmt_watts(node.cost)}, "
                           f"have {fmt_watts(available)} (research fund + treasury).")
        remaining = node.cost
        from_fund = min(self.research_fund, remaining)
        self.research_fund -= from_fund
        remaining -= from_fund
        self.watts -= remaining
        self.techtree.mark_researched(key)
        return True, f"Researched {node.name}! +{fmt_watts(node.wps_bonus, True)} base output."

    def appease_cost(self, faction: Faction) -> float:
        per_tick = self.potential_wps * TICK_SECONDS
        if faction.civil_war:
            return max(100.0, per_tick * 4.0)
        return max(25.0, per_tick * (0.5 + faction.influence / 100.0))

    def address_unrest(self, faction: Faction) -> Tuple[bool, str]:
        if faction.influence < 5.0 and not faction.active:
            return False, f"The {faction.name} are content; nothing to address."
        cost = self.appease_cost(faction)
        if self.watts < cost:
            return False, f"Need {fmt_watts(cost)} in the treasury (have {fmt_watts(self.watts)})."
        self.watts -= cost
        had_crisis = faction.active
        returned = faction.hoard
        self.watts += returned
        faction.hoard = 0.0
        faction.strike_ticks = 0
        bonus = 15.0 if faction.civil_war else 10.0
        faction.civil_war = False
        faction.influence = max(0.0, faction.influence - 30.0)
        self.population.cohesion = clamp(self.population.cohesion + bonus, 0.0, 100.0)
        if had_crisis:
            self.crises_resolved += 1
        extra = f" Recovered {fmt_watts(returned)} of hoarded energy." if returned > 0 else ""
        return True, f"Spent {fmt_watts(cost)} placating the {faction.name}. Cohesion +{bonus:.0f}.{extra}"

    def set_allocation(self, comfort: int, research: int, conquest: int) -> Tuple[bool, str]:
        candidate = Allocation(comfort, research, conquest)
        if not candidate.is_valid():
            return False, "Each value must be 0-100 and the total cannot exceed 100."
        self.allocation = candidate
        return True, (f"Budget set: Comfort {comfort}% | Research {research}% | "
                      f"Conquest {conquest}% | Reserve {candidate.reserve}%.")

    def victory(self) -> bool:
        return self.highest_tier >= 5 and self.techtree.all_researched()

    @property
    def game_over(self) -> bool:
        return self.victory() or self.defeated_by is not None

    def refresh(self) -> List[str]:
        """Re-evaluate tier and achievements after a player action."""
        self.highest_tier = max(self.highest_tier, self.tier.level)
        return self.achievements.check(self)

    # ---- (de)serialization: lets a stateless server (Vercel) resume any game ---- #

    def to_dict(self) -> Dict[str, object]:
        return {
            "seed": self.seed,
            "tick": self.tick_count,
            "watts": self.watts,
            "research_fund": self.research_fund,
            "conquest_bonus": self.conquest_bonus,
            "highest_tier": self.highest_tier,
            "crises_resolved": self.crises_resolved,
            "defeated_by": self.defeated_by,
            "allocation": {"comfort": self.allocation.comfort, "research": self.allocation.research,
                           "conquest": self.allocation.conquest},
            "population": {"free_will": self.population.free_will, "cohesion": self.population.cohesion,
                           "streak": self.population.high_cohesion_streak},
            "factions": {f.name: {"influence": f.influence, "hoard": f.hoard,
                                  "strike_ticks": f.strike_ticks, "civil_war": f.civil_war}
                         for f in self.factions},
            "researched": [n.key for n in self.techtree.ordered() if n.researched],
            "achievements": [a.key for a in self.achievements.achievements if a.unlocked],
            "rivals": [{"name": r.name, "iq": r.iq, "start_iq": r.start_iq, "wps": r.wps,
                        "highest_tier": r.highest_tier, "blunders": r.blunders, "ticks": r.ticks,
                        "iq_milestone": r.iq_milestone} for r in self.rivals],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "Game":
        """Rebuild a game from client-supplied state, clamping every field to a sane range."""

        def num(value: object, default: float, low: float, high: float) -> float:
            try:
                number = float(value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return default
            return clamp(number, low, high) if math.isfinite(number) else default

        game = cls(int(num(data.get("seed"), 1, 1, 10**12)))
        game.tick_count = int(num(data.get("tick"), 0, 0, 10**6))
        game.watts = num(data.get("watts"), 0.0, 0.0, 1e30)
        game.research_fund = num(data.get("research_fund"), 0.0, 0.0, 1e30)
        game.conquest_bonus = num(data.get("conquest_bonus"), 0.0, 0.0, CONQUEST_BONUS_CAP)
        game.highest_tier = int(num(data.get("highest_tier"), 0, 0, 5))
        game.crises_resolved = int(num(data.get("crises_resolved"), 0, 0, 10**6))
        defeated = data.get("defeated_by")
        game.defeated_by = defeated if isinstance(defeated, str) and defeated in {r.name for r in game.rivals} else None

        alloc = data.get("allocation") if isinstance(data.get("allocation"), dict) else {}
        candidate = Allocation(int(num(alloc.get("comfort"), 30, 0, 100)),  # type: ignore[union-attr]
                               int(num(alloc.get("research"), 30, 0, 100)),  # type: ignore[union-attr]
                               int(num(alloc.get("conquest"), 10, 0, 100)))  # type: ignore[union-attr]
        if candidate.is_valid():
            game.allocation = candidate

        pop = data.get("population") if isinstance(data.get("population"), dict) else {}
        game.population.free_will = num(pop.get("free_will"), 50.0, 0.0, 100.0)  # type: ignore[union-attr]
        game.population.cohesion = num(pop.get("cohesion"), 75.0, 0.0, 100.0)  # type: ignore[union-attr]
        game.population.high_cohesion_streak = int(num(pop.get("streak"), 0, 0, 10**6))  # type: ignore[union-attr]

        faction_data = data.get("factions") if isinstance(data.get("factions"), dict) else {}
        for faction in game.factions:
            saved = faction_data.get(faction.name)  # type: ignore[union-attr]
            if isinstance(saved, dict):
                faction.influence = num(saved.get("influence"), 10.0, 0.0, 100.0)
                faction.hoard = num(saved.get("hoard"), 0.0, 0.0, 1e30)
                faction.strike_ticks = int(num(saved.get("strike_ticks"), 0, 0, 50))
                faction.civil_war = bool(saved.get("civil_war", False))

        researched = data.get("researched")
        if isinstance(researched, list):
            for key in researched:
                if isinstance(key, str) and key in game.techtree.nodes:
                    game.techtree.nodes[key].researched = True
        unlocked = data.get("achievements")
        if isinstance(unlocked, list):
            for ach in game.achievements.achievements:
                ach.unlocked = ach.key in unlocked

        rival_data = data.get("rivals")
        if isinstance(rival_data, list):
            saved_by_name = {r.get("name"): r for r in rival_data if isinstance(r, dict)}
            for rival in game.rivals:
                saved = saved_by_name.get(rival.name)
                if saved:
                    rival.iq = num(saved.get("iq"), rival.iq, 40.0, 200.0)
                    rival.start_iq = num(saved.get("start_iq"), rival.start_iq, 40.0, 200.0)
                    rival.wps = num(saved.get("wps"), STARTING_WPS, 1.0, 1e14)
                    rival.highest_tier = int(num(saved.get("highest_tier"), 0, 0, 5))
                    rival.blunders = int(num(saved.get("blunders"), 0, 0, 10**6))
                    rival.ticks = int(num(saved.get("ticks"), 0, 0, 10**6))
                    rival.iq_milestone = int(num(saved.get("iq_milestone"), int(rival.iq // 10), 0, 30))
        return game

    def to_view(self) -> Dict[str, object]:
        """Everything a front end needs to render, with derived stats included."""
        tier = self.tier
        return {
            "tick": self.tick_count,
            "seconds": self.tick_count * TICK_SECONDS,
            "watts": self.watts,
            "research_fund": self.research_fund,
            "wps": self.wps,
            "potential_wps": self.potential_wps,
            "raw_wps": self.raw_wps,
            "multiplier": self.multiplier,
            "penalty": self.penalty_modifier,
            "tier": {"level": tier.level, "name": tier.name},
            "highest_tier": self.highest_tier,
            "next_tier": ({"level": TIERS[tier.level + 1].level, "name": TIERS[tier.level + 1].name,
                           "threshold": TIERS[tier.level + 1].wps_threshold} if tier.level < 5 else None),
            "cohesion": self.population.cohesion,
            "free_will": self.population.free_will,
            "required_comfort": Allocation.required_comfort(tier.level),
            "allocation": {"comfort": self.allocation.comfort, "research": self.allocation.research,
                           "conquest": self.allocation.conquest, "reserve": self.allocation.reserve},
            "factions": [{"name": f.name, "description": f.description, "influence": f.influence,
                          "status": f.status_text(), "active": f.active, "civil_war": f.civil_war,
                          "cost": self.appease_cost(f)} for f in self.factions],
            "techs": [{"key": n.key, "name": n.name, "description": n.description, "cost": n.cost,
                       "wps_bonus": n.wps_bonus, "tier": n.tier, "researched": n.researched,
                       "missing": [self.techtree.nodes[m].name for m in self.techtree.missing_prerequisites(n.key)],
                       "affordable": (self.research_fund + self.watts) >= n.cost}
                      for n in self.techtree.ordered()],
            "achievements": [{"name": a.name, "description": a.description, "multiplier": a.multiplier,
                              "unlocked": a.unlocked} for a in self.achievements.achievements],
            "rivals": [{"name": r.name, "iq": r.iq, "start_iq": r.start_iq, "label": r.label,
                        "tier": r.tier.level, "tier_name": r.tier.name, "wps": r.wps,
                        "blunders": r.blunders, "progress": r.progress} for r in self.rivals],
            "victory": self.victory(),
            "defeated_by": self.defeated_by,
            "game_over": self.game_over,
        }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def render_telemetry(game: Game) -> None:
    tier = game.tier
    a = game.allocation
    pop = game.population
    required = Allocation.required_comfort(tier.level)

    print()
    print("=" * 64)
    print(f" ASCENSION: TYPE OMEGA   |   Tick {game.tick_count}   |   "
          f"T+{game.tick_count * TICK_SECONDS:,}s")
    print("=" * 64)
    print(f" Watts (treasury): {fmt_watts(game.watts)}")
    print(f" Research fund:    {fmt_watts(game.research_fund)}")
    modifier = ""
    if game.civil_war_active:
        modifier = "  [CIVIL WAR: x0.25]"
    elif game.strike_active:
        modifier = "  [STRIKE: x0.50]"
    print(f" WPS:              {fmt_watts(game.wps, True)}{modifier}")
    print(f"   base {fmt_watts(game.raw_wps, True)} x multiplier {game.multiplier:.2f}")
    print(f" Tier {tier.level}: {tier.name}")
    print(f" Cohesion:         {pop.cohesion:5.1f}% {bar(pop.cohesion)}")
    print(f" Free Will:        {pop.free_will:5.1f}% {bar(pop.free_will)}")
    print(f" Budget: Comfort {a.comfort}% (need >= {required}%) | Research {a.research}% | "
          f"Conquest {a.conquest}% | Reserve {a.reserve}%")
    print(" Factions:")
    for f in game.factions:
        flag = "ACTIVE" if f.active else "      "
        print(f"   {flag} {f.name:<20} influence {f.influence:5.1f}  [{f.status_text()}]")
    print(" Rivals:")
    for r in game.rivals:
        print(f"   {r.name:<20} Tier {r.tier.level}  {fmt_watts(r.wps, True):>14}  IQ {r.iq:5.1f} ({r.label})")
    print("-" * 64)


def print_menu() -> None:
    print(" 1: Step Tick  (e.g. '1 10' to step 10)   2: Research Tech")
    print(" 3: Address Faction Unrest                 4: Exit")
    print(" 5: Adjust Budget Allocation               6: Intel Report (rivals)")


def menu_intel(game: Game) -> None:
    print("\n INTEL REPORT - rival civilizations")
    for r in sorted(game.rivals, key=lambda x: x.wps, reverse=True):
        print(f"  {r.name:<20} Tier {r.tier.level} {r.tier.name}")
        print(f"     Output {fmt_watts(r.wps, True)}   Race to Tier 5 {bar(r.progress * 100, 20)} {r.progress * 100:4.0f}%")
        print(f"     IQ {r.iq:5.1f} ({r.label}), started {r.start_iq:5.1f} ({r.iq - r.start_iq:+.1f})   blunders {r.blunders}")
    print("  Smart rivals compound faster, blunder less, and steal more from a disunited civilization.")


def safe_input(prompt: str) -> Optional[str]:
    try:
        return input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return None


def menu_research(game: Game) -> None:
    print("\n TECH TREE")
    options = game.techtree.ordered()
    for i, node in enumerate(options, start=1):
        if node.researched:
            status = "RESEARCHED"
        else:
            missing = game.techtree.missing_prerequisites(node.key)
            status = "locked (needs " + ", ".join(game.techtree.nodes[m].name for m in missing) + ")" if missing else "available"
        print(f"  {i}. {node.name:<22} cost {fmt_watts(node.cost):>12}  "
              f"+{fmt_watts(node.wps_bonus, True):>12}  Tier {node.tier}  [{status}]")
        print(f"       {node.description}")
    print(f"  Funds: research fund {fmt_watts(game.research_fund)} + treasury {fmt_watts(game.watts)}")
    raw = safe_input(" Tech number (blank to cancel): ")
    if not raw:
        return
    if not raw.isdigit() or not (1 <= int(raw) <= len(options)):
        print(" Invalid selection.")
        return
    ok, msg = game.research(options[int(raw) - 1].key)
    print(f" {'OK' if ok else 'FAILED'}: {msg}")
    if ok:
        game.highest_tier = max(game.highest_tier, game.tier.level)
        for line in game.achievements.check(game):
            print(f" {line}")


def menu_unrest(game: Game) -> None:
    print("\n FACTION UNREST")
    for i, f in enumerate(game.factions, start=1):
        print(f"  {i}. {f.name:<20} influence {f.influence:5.1f}  [{f.status_text()}]  "
              f"cost {fmt_watts(game.appease_cost(f))}")
        print(f"       {f.description}")
    raw = safe_input(" Faction number (blank to cancel): ")
    if not raw:
        return
    if not raw.isdigit() or not (1 <= int(raw) <= len(game.factions)):
        print(" Invalid selection.")
        return
    ok, msg = game.address_unrest(game.factions[int(raw) - 1])
    print(f" {'OK' if ok else 'FAILED'}: {msg}")
    if ok:
        for line in game.achievements.check(game):
            print(f" {line}")


def menu_allocation(game: Game) -> None:
    a = game.allocation
    print(f"\n Current: Comfort {a.comfort}% | Research {a.research}% | "
          f"Conquest {a.conquest}% | Reserve {a.reserve}%")
    print(" Enter three whole numbers: comfort research conquest (sum <= 100; the rest goes to reserve).")
    print(" Comfort feeds Cohesion, Research fills the research fund, Conquest grows a WPS bonus.")
    raw = safe_input(" e.g. '35 30 10' (blank to cancel): ")
    if not raw:
        return
    parts = raw.replace(",", " ").split()
    if len(parts) != 3 or not all(p.lstrip("-").isdigit() for p in parts):
        print(" Invalid input: need exactly three whole numbers.")
        return
    ok, msg = game.set_allocation(int(parts[0]), int(parts[1]), int(parts[2]))
    print(f" {'OK' if ok else 'FAILED'}: {msg}")


def run_cli(seed: Optional[int] = None) -> int:
    game = Game(seed)
    print("\n  A S C E N S I O N :  T Y P E   O M E G A")
    print("  Climb from a campfire to a multiversal power. Keep your people together.")
    render_telemetry(game)

    while True:
        print_menu()
        raw = safe_input(" > ")
        if raw is None:
            print(" Input closed. Exiting.")
            return 0
        parts = raw.split()
        choice = parts[0] if parts else ""

        if choice == "1":
            count = 1
            if len(parts) > 1:
                if parts[1].isdigit() and int(parts[1]) >= 1:
                    count = min(int(parts[1]), MAX_BATCH_TICKS)
                else:
                    print(" Batch size must be a positive whole number; stepping once.")
            for _ in range(count):
                for line in game.step_tick():
                    print(f" [tick {game.tick_count}] {line}")
                if game.game_over:
                    break
            render_telemetry(game)
            if game.victory():
                print("\n *** TYPE OMEGA ACHIEVED: Multiversal Mastery with every technology unlocked. ***")
                print(f" Your civilization ascended in {game.tick_count} ticks. Final multiplier x{game.multiplier:.2f}.")
                return 0
            if game.defeated_by:
                print(f"\n *** DEFEAT: {game.defeated_by} beat you to Multiversal Mastery at tick {game.tick_count}. ***")
                return 0
        elif choice == "2":
            menu_research(game)
            render_telemetry(game)
        elif choice == "3":
            menu_unrest(game)
            render_telemetry(game)
        elif choice == "4":
            print(f" Simulation ended at tick {game.tick_count}, Tier {game.tier.level}. Farewell, Architect.")
            return 0
        elif choice == "5":
            menu_allocation(game)
            render_telemetry(game)
        elif choice == "6":
            menu_intel(game)
        else:
            print(" Unknown option. Choose 1-6.")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Ascension: Type Omega")
    parser.add_argument("--seed", type=int, default=None, help="RNG seed for reproducible runs")
    args = parser.parse_args(argv)
    return run_cli(args.seed)


if __name__ == "__main__":
    sys.exit(main())
