import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "indexer.db"

if __name__ == "__main__":
    if DB_PATH.exists():
        print(f"Removing old database at {DB_PATH}...")
        os.remove(DB_PATH)
        print("Done. It will be recreated with the new schema on the next run.")
    else:
        print("No database found to reset.")
