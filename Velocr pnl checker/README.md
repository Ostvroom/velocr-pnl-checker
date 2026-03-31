# NFT PNL Checker (Velocr)

FastAPI dashboard for estimating NFT trading PnL on EVM chains (Moralis-backed).

## Run locally

1. Create a `.env` file in the project root:

```
MORALIS_API_KEY=YOUR_KEY_HERE
```

2. Install dependencies:

```
python -m pip install -U pip
python -m pip install -e .
```

3. Start the server:

```
python -m uvicorn velocr_pnl.web_app:app --host 127.0.0.1 --port 8080
```

Open `http://127.0.0.1:8080/`.

