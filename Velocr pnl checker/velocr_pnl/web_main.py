"""Entry point for `velocr-web` (uvicorn)."""

import os

import uvicorn


def main() -> None:
    host = (os.getenv("VELOCR_WEB_HOST") or "127.0.0.1").strip()
    try:
        port = int((os.getenv("VELOCR_WEB_PORT") or "8080").strip())
    except ValueError:
        port = 8080
    uvicorn.run(
        "velocr_pnl.web_app:app",
        host=host,
        port=port,
        reload=os.getenv("VELOCR_WEB_RELOAD", "").lower() in ("1", "true", "yes"),
    )


if __name__ == "__main__":
    main()
