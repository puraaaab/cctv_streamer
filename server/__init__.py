import sys

# Prevent blocked or corrupted optional binary C-extension packages
# (e.g. ujson/orjson blocked by Windows Application Control or AppLocker policies)
# from breaking FastAPI startup. Setting sys.modules entry to None tells Python
# that the module is unavailable, allowing FastAPI's ModuleNotFoundError handler
# to cleanly fall back to the built-in json serializer.
for _mod in ("ujson", "orjson"):
    try:
        __import__(_mod)
    except Exception:
        sys.modules[_mod] = None
