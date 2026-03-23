"""Shared state accessors for API routers.

The flight daemon and other singletons are created in main.py's lifespan
and registered here so API routers can access them without circular imports.
"""

_daemon = None
_tracker = None


def set_daemon(daemon):
    global _daemon
    _daemon = daemon


def get_daemon():
    if _daemon is None:
        raise RuntimeError("Flight daemon not initialized")
    return _daemon


def set_tracker(tracker):
    global _tracker
    _tracker = tracker


def get_tracker():
    return _tracker
