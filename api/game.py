"""Vercel serverless entry point for Ascension: Type Omega.

Vercel functions are stateless, so the browser holds the game state and sends it
with every request. One endpoint (POST /api/game) takes an `action` and returns the
updated state, a render-ready view, and any log messages.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# The engine lives in the repo root; make it importable both locally and on Vercel.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _path in (_ROOT, os.getcwd()):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from ascension import MAX_BATCH_TICKS, Game  # noqa: E402

app = FastAPI(title="Ascension: Type Omega")


class ActionRequest(BaseModel):
    action: str
    state: Optional[Dict[str, Any]] = None
    seed: Optional[int] = None        # new
    count: Optional[int] = None       # step
    key: Optional[str] = None         # research
    faction: Optional[str] = None     # address
    comfort: Optional[int] = None     # allocate
    research: Optional[int] = None    # allocate
    conquest: Optional[int] = None    # allocate


def _respond(game: Game, ok: bool, message: str, log: List[str]) -> Dict[str, Any]:
    return {"ok": ok, "message": message, "log": log, "state": game.to_dict(), "view": game.to_view()}


def handle(req: ActionRequest) -> Dict[str, Any]:
    if req.action == "new":
        seed = req.seed if req.seed is not None and req.seed > 0 else None
        game = Game(seed)
        return _respond(game, True, "New civilization founded.", [])

    if req.state is None:
        raise HTTPException(status_code=400, detail="Missing game state.")
    try:
        game = Game.from_dict(req.state)
    except (TypeError, ValueError, KeyError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid game state: {exc}") from exc

    if req.action == "load":
        return _respond(game, True, "Game loaded.", [])

    if req.action == "step":
        count = max(1, min(req.count or 1, MAX_BATCH_TICKS))
        log: List[str] = []
        for _ in range(count):
            if game.game_over:
                break
            for line in game.step_tick():
                log.append(f"[t{game.tick_count}] {line}")
        return _respond(game, True, f"Advanced {count} tick(s).", log)

    if game.game_over:
        return _respond(game, False, "The simulation has ended. Start a new game.", [])

    if req.action == "research":
        if not req.key:
            raise HTTPException(status_code=400, detail="Missing tech key.")
        ok, message = game.research(req.key)
        log = [f"[t{game.tick_count}] {line}" for line in game.refresh()] if ok else []
        return _respond(game, ok, message, log)

    if req.action == "address":
        target = next((f for f in game.factions if f.name == req.faction), None)
        if target is None:
            raise HTTPException(status_code=400, detail="Unknown faction.")
        ok, message = game.address_unrest(target)
        log = [f"[t{game.tick_count}] {line}" for line in game.refresh()] if ok else []
        return _respond(game, ok, message, log)

    if req.action == "allocate":
        if req.comfort is None or req.research is None or req.conquest is None:
            raise HTTPException(status_code=400, detail="Need comfort, research and conquest.")
        ok, message = game.set_allocation(req.comfort, req.research, req.conquest)
        return _respond(game, ok, message, [])

    raise HTTPException(status_code=400, detail=f"Unknown action '{req.action}'.")


@app.get("/api/game")
def health() -> Dict[str, str]:
    return {"status": "ok", "game": "Ascension: Type Omega"}


@app.post("/api/game")
def play(req: ActionRequest) -> Dict[str, Any]:
    return handle(req)
