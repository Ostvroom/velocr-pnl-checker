const axios = require('axios');
const fs = require('fs');
const path = require('path');

class NftApiClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.hasKey = !!apiKey && apiKey.length > 10;
    this.nftBaseUrl = this.hasKey ? `https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey}` : null;
    this.nftV2BaseUrl = this.hasKey ? `https://eth-mainnet.g.alchemy.com/nft/v2/${apiKey}` : null;
    this.rpcBaseUrl = this.hasKey ? `https://eth-mainnet.g.alchemy.com/v2/${apiKey}` : null;

    // OpenSea floor source (more accurate than Alchemy; covers Blur-listed collections).
    // Uses an env key if present, else auto-generates a free 30-day key on demand.
    this.openSeaKey = process.env.OPENSEA_API_KEY || null;
    this.openSeaKeyExpiry = this.openSeaKey ? Infinity : 0;
    this.openSeaKeyFile = path.join(__dirname, '..', 'data', 'opensea-key.json');
    this.slugCache = new Map();        // contract -> collection slug
    this.floorCache = new Map();       // contract -> { floor, ts }
    this.saleFeeCache = new Map();     // contract -> { rate, samples, ts }
    this.floorCacheTtl = 5 * 60 * 1000; // 5 min
    this._loadOpenSeaKey();
  }

  // ── OpenSea key management ──────────────────────────────────────────────
  _loadOpenSeaKey() {
    if (this.openSeaKey) return; // env key wins
    try {
      if (fs.existsSync(this.openSeaKeyFile)) {
        const d = JSON.parse(fs.readFileSync(this.openSeaKeyFile, 'utf8'));
        if (d.key && d.expiresAt && Date.parse(d.expiresAt) > Date.now() + 60000) {
          this.openSeaKey = d.key;
          this.openSeaKeyExpiry = Date.parse(d.expiresAt);
        }
      }
    } catch (e) { /* ignore */ }
  }

  async _ensureOpenSeaKey() {
    if (this.openSeaKey && this.openSeaKeyExpiry > Date.now() + 60000) return this.openSeaKey;
    // Generate a fresh free key (rate-limited to 1/hour by OpenSea)
    try {
      const res = await axios.post('https://api.opensea.io/api/v2/auth/keys', null, {
        headers: { accept: 'application/json' }, timeout: 10000
      });
      const key = res.data?.api_key;
      const expiresAt = res.data?.expires_at;
      if (key) {
        this.openSeaKey = key;
        this.openSeaKeyExpiry = expiresAt ? Date.parse(expiresAt) : Date.now() + 25 * 24 * 3600 * 1000;
        try {
          fs.mkdirSync(path.dirname(this.openSeaKeyFile), { recursive: true });
          fs.writeFileSync(this.openSeaKeyFile, JSON.stringify({ key, expiresAt }, null, 2));
        } catch (e) { /* ignore persist failure */ }
        console.log('Generated free OpenSea API key (expires', expiresAt + ')');
        return key;
      }
    } catch (e) {
      console.warn('Could not obtain OpenSea key:', e.response?.data?.errors?.[0] || e.message);
    }
    return null;
  }

  async openSeaGet(urlPath) {
    const key = await this._ensureOpenSeaKey();
    if (!key) return null;
    try {
      const res = await axios.get(`https://api.opensea.io/api/v2/${urlPath}`, {
        headers: { accept: 'application/json', 'X-API-KEY': key }, timeout: 12000
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 401) { this.openSeaKey = null; this.openSeaKeyExpiry = 0; }
      return null;
    }
  }

  /**
   * Fetch a collection's floor price from OpenSea (contract → slug → stats).
   * Returns 0 if unavailable. Slugs cached permanently, floors for 5 min.
   */
  async getOpenSeaFloor(contract) {
    const lc = contract.toLowerCase();
    let slug = this.slugCache.get(lc);
    if (!slug) {
      const c = await this.openSeaGet(`chain/ethereum/contract/${contract}`);
      slug = c?.collection;
      if (slug) this.slugCache.set(lc, slug);
    }
    if (!slug) return 0;
    const stats = await this.openSeaGet(`collections/${slug}/stats`);
    const floor = stats?.total?.floor_price || 0;
    return floor > 0.0000001 ? floor : 0;
  }

  async getReservoirFloor(contract) {
    try {
      const res = await axios.get('https://api.reservoir.tools/collections/v7', {
        params: { id: contract.toLowerCase() },
        headers: { accept: 'application/json' },
        timeout: 12000
      });
      const collection = res.data?.collections?.[0];
      const floor = Number(collection?.floorAsk?.price?.amount?.decimal) || 0;
      if (floor > 0.0000001) {
        console.log(`[Floor] Reservoir floor: ${floor.toFixed(4)} ETH`);
        return floor;
      }
    } catch (e) {
      console.warn(`[Floor] Reservoir floor fetch failed: ${e.message}`);
    }
    return 0;
  }

  extractAlchemyFloor(data) {
    if (!data) return 0;
    const candidates = [
      data.openSea?.floorPrice,
      data.looksRare?.floorPrice,
      data.openSeaMetadata?.floorPrice,
      data.contract?.openSeaMetadata?.floorPrice,
      data.floorPrice
    ]
      .map(value => Number(value) || 0)
      .filter(value => value > 0.00001);
    return candidates.length > 0 ? Math.min(...candidates) : 0;
  }

  async getAlchemyFloor(contract) {
    const sources = [
      { name: 'Alchemy v3 getFloorPrice', url: `${this.nftBaseUrl}/getFloorPrice` },
      { name: 'Alchemy v2 getFloorPrice', url: `${this.nftV2BaseUrl}/getFloorPrice` },
      { name: 'Alchemy contract metadata', url: `${this.nftBaseUrl}/getContractMetadata` }
    ];

    for (const source of sources) {
      const data = await this.request(source.url, { contractAddress: contract });
      const floor = this.extractAlchemyFloor(data);
      if (floor > 0) {
        console.log(`[Floor] ${source.name}: ${floor.toFixed(4)} ETH`);
        return floor;
      }
      console.log(`[Floor] ${source.name}: no usable floor`);
    }

    return 0;
  }

  async request(url, params = {}) {
    try {
      const response = await axios.get(url, { params, timeout: 15000 });
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      console.error(`Alchemy API error ${status}: ${message}`);
      return null;
    }
  }

  async rpcRequest(method, params = []) {
    try {
      const response = await axios.post(this.rpcBaseUrl, {
        jsonrpc: '2.0', id: 1, method, params
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      return response.data?.result || null;
    } catch (error) {
      console.error(`Alchemy RPC error: ${error.response?.data?.error?.message || error.message}`);
      return null;
    }
  }

  checkKey() {
    if (!this.hasKey) {
      return {
        error: '**Alchemy API key is missing.**\n\nGet a free key at https://dashboard.alchemy.com → Create App → Ethereum Mainnet → Copy API Key\nThen add it to your `.env` file:\n```\nALCHEMY_API_KEY=your_key_here\n```'
      };
    }
    return null;
  }

  isSpamNft(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    const spamPatterns = [
      'http', 'https', '.com', '.org', '.net', '.io',
      'claim', 'reward', 'airdrop', 'verify', 'connect',
      'visit', 'click', 'website', 'protocol', 'register',
      'approve', 'secure', 'suspicious', 'refund',
      'uniswapv3', 'opensea.pro', 'blur.io', 'looksrare',
      'tenthousand', 'thousandtoken', 'milliontoken',
      'freetoken', 'gift', 'bonus', 'prize', 'winner',
      'drain', 'sweep', 'revoke', 'scam', 'phishing',
      'you won', 'congratulations', 'exclusive', 'limited',
      'act now', 'urgent', 'warning', 'alert',
      'wallet access', 'sign message', 'private key'
    ];
    return spamPatterns.some(p => lower.includes(p));
  }

  formatTokenId(tokenId) {
    if (!tokenId) return '';
    if (tokenId.length > 20) {
      return `${tokenId.substring(0, 6)}…${tokenId.substring(tokenId.length - 4)}`;
    }
    return tokenId;
  }

  // Alchemy's getNFTsForOwner returns tokenId as decimal string ("1234")
  // but alchemy_getAssetTransfers returns it as hex string ("0x4d2").
  // Normalize both to decimal for reliable comparison.
  normalizeTokenId(tokenId) {
    if (tokenId === null || tokenId === undefined || tokenId === '') return '';
    const str = String(tokenId).trim();
    if (/^0x[0-9a-fA-F]+$/i.test(str)) {
      try { return BigInt(str).toString(10); } catch (e) { return str; }
    }
    return str;
  }

  // Check whether an asset-transfer record refers to a given (normalized) tokenId.
  // ERC721 transfers carry the id in `tokenId`; ERC1155 transfers set `tokenId: null`
  // and put the real id inside the `erc1155Metadata` array. Handle both.
  transferMatchesToken(transfer, tokenIdNorm) {
    if (!transfer) return false;
    if (this.normalizeTokenId(transfer.tokenId) === tokenIdNorm) return true;
    if (Array.isArray(transfer.erc1155Metadata)) {
      return transfer.erc1155Metadata.some(
        m => this.normalizeTokenId(m?.tokenId) === tokenIdNorm
      );
    }
    return false;
  }

  /**
   * Count how many NFTs from the same contract moved to/from `wallet` in a single tx.
   * Used to split batch prices fairly (e.g. buying/selling N NFTs in one tx → price/N each).
   * direction: 'to' = received (buys), 'from' = sent (sells).
   */
  async countNftsInTx(txHash, wallet, contract, direction = 'to') {
    if (!txHash) return 1;
    try {
      const receipt = await this.rpcRequest('eth_getTransactionReceipt', [txHash]);
      if (!receipt?.logs) return 1;
      const ERC721_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const ERC1155_SINGLE  = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
      const ERC1155_BATCH   = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
      const normalizedWallet = wallet.toLowerCase();
      const normalizedContract = contract.toLowerCase();
      // ERC721 Transfer topics: [sig, from, to]   (from=1, to=2)
      // ERC1155 Single/Batch topics: [sig, operator, from, to]   (from=2, to=3)
      const erc721Idx = direction === 'from' ? 1 : 2;
      const erc1155Idx = direction === 'from' ? 2 : 3;
      let count = 0;
      for (const log of receipt.logs) {
        if (log.address?.toLowerCase() !== normalizedContract) continue;
        const topic = log.topics?.[0];
        if (topic === ERC721_TRANSFER) {
          if (log.topics.length < 3) continue;
          const addr = '0x' + log.topics[erc721Idx].slice(-40).toLowerCase();
          if (addr === normalizedWallet) count++;
        } else if (topic === ERC1155_SINGLE) {
          if (log.topics.length < 4) continue;
          const addr = '0x' + log.topics[erc1155Idx].slice(-40).toLowerCase();
          if (addr !== normalizedWallet) continue;
          // data = [id(32), value(32)] — add the transferred quantity
          count += this._hexWordToInt(log.data, 1);
        } else if (topic === ERC1155_BATCH) {
          if (log.topics.length < 4) continue;
          const addr = '0x' + log.topics[erc1155Idx].slice(-40).toLowerCase();
          if (addr !== normalizedWallet) continue;
          count += this._sumErc1155BatchValues(log.data);
        }
      }
      return Math.max(1, count);
    } catch (e) {
      return 1;
    }
  }

  // Read the Nth 32-byte word (0-indexed) of ABI-encoded hex data as an integer.
  _hexWordToInt(data, wordIndex) {
    try {
      const hex = (data || '').startsWith('0x') ? data.slice(2) : (data || '');
      const word = hex.slice(wordIndex * 64, wordIndex * 64 + 64);
      if (!word) return 0;
      const n = parseInt(word, 16);
      return Number.isFinite(n) ? n : 0;
    } catch (e) { return 0; }
  }

  // Sum the `values[]` array of an ERC1155 TransferBatch payload: abi(ids[], values[]).
  _sumErc1155BatchValues(data) {
    try {
      const hex = (data || '').startsWith('0x') ? data.slice(2) : (data || '');
      const word = (i) => parseInt(hex.slice(i * 64, i * 64 + 64), 16) || 0;
      // word(1) = byte-offset to the values array; convert bytes → word index.
      const valuesOffsetWords = word(1) / 32;
      const len = word(valuesOffsetWords);
      if (!Number.isFinite(len) || len <= 0) return 1;
      let sum = 0;
      for (let i = 1; i <= len; i++) sum += word(valuesOffsetWords + i);
      return sum > 0 ? sum : len; // fall back to item count if amounts unreadable
    } catch (e) { return 1; }
  }

  // Back-compat alias for buy-side batch counting.
  async countNftsReceivedInTx(txHash, wallet, contract) {
    return this.countNftsInTx(txHash, wallet, contract, 'to');
  }

  // Extract the usable decimal tokenId from a transfer record (ERC721 or ERC1155).
  getTransferTokenId(transfer) {
    if (!transfer) return '';
    if (transfer.tokenId !== null && transfer.tokenId !== undefined) {
      return this.normalizeTokenId(transfer.tokenId);
    }
    if (Array.isArray(transfer.erc1155Metadata) && transfer.erc1155Metadata[0]?.tokenId) {
      return this.normalizeTokenId(transfer.erc1155Metadata[0].tokenId);
    }
    return '';
  }

  async getTxEthValue(txHash) {
    if (!txHash) return 0;
    try {
      const tx = await this.rpcRequest('eth_getTransactionByHash', [txHash]);
      if (!tx || !tx.value) return 0;
      const wei = parseInt(tx.value, 16);
      return wei / 1e18;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Use trace_transaction to find internal ETH transfers.
   * mode: 'buy'  => sum value where from == wallet (what wallet paid)
   * mode: 'sell' => sum value where to   == wallet (what wallet received)
   */
  async getPriceFromTrace(txHash, wallet, mode = 'sell') {
    if (!txHash || !wallet) return 0;
    const normalizedWallet = wallet.toLowerCase();
    try {
      const traces = await this.rpcRequest('trace_transaction', [txHash]);
      if (!Array.isArray(traces) || traces.length === 0) return 0;

      let totalWei = 0;
      for (const trace of traces) {
        const action = trace.action || {};
        const value = action.value;
        if (!value || value === '0x0') continue;

        const from = (action.from || '').toLowerCase();
        const to = (action.to || '').toLowerCase();
        const wei = parseInt(value, 16);
        if (isNaN(wei) || wei <= 0) continue;

        if (mode === 'sell' && to === normalizedWallet) {
          totalWei += wei;
        } else if (mode === 'buy' && from === normalizedWallet) {
          totalWei += wei;
        }
      }
      return totalWei / 1e18;
    } catch (e) {
      console.error(`trace_transaction error: ${e.message}`);
      return 0;
    }
  }

  /**
   * Detect WETH transfer price by parsing transaction receipt logs directly.
   * Much more reliable than alchemy_getAssetTransfers for marketplace txns.
   * WETH Transfer event: keccak256("Transfer(address,address,uint256)")
   */
  async getWethPriceFromTx(txHash, wallet, mode = 'buy') {
    if (!txHash || !wallet) return 0;
    // ETH-equivalent payment tokens used by NFT marketplaces.
    const PAYMENT_TOKENS = new Set([
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
      '0x0000000000a39bb272e79075ade125fd351887ac'  // Blur Pool (Blur's pooled ETH)
    ]);
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const normalizedWallet = wallet.toLowerCase();

    try {
      const receipt = await this.rpcRequest('eth_getTransactionReceipt', [txHash]);
      if (!receipt || !Array.isArray(receipt.logs)) return 0;

      let total = 0;
      for (const log of receipt.logs) {
        if (!PAYMENT_TOKENS.has(log.address?.toLowerCase())) continue;
        if (log.topics[0] !== TRANSFER_TOPIC) continue;
        // Topics: [eventSig, from (indexed), to (indexed)]
        if (log.topics.length < 3) continue;

        const from = '0x' + log.topics[1].slice(-40).toLowerCase();
        const to   = '0x' + log.topics[2].slice(-40).toLowerCase();
        const valueWei = parseInt(log.data, 16);
        if (isNaN(valueWei) || valueWei <= 0) continue;
        const valueEth = valueWei / 1e18;

        if (mode === 'buy' && from === normalizedWallet) {
          total += valueEth;
        } else if (mode === 'sell' && to === normalizedWallet) {
          total += valueEth;
        }
      }
      return total;
    } catch (e) {
      console.error(`WETH log detection error: ${e.message}`);
      return 0;
    }
  }

  /**
   * Net value a wallet actually RECEIVED (mode 'sell') or PAID (mode 'buy') in a tx,
   * across native ETH (internal transfers) + WETH/Blur-Pool token transfers.
   * For sells this is the real take-home AFTER marketplace fee + royalty — which is
   * what PnL must use, unlike the gross buyer-side tx.value. A sale settles in either
   * ETH or a token (not both), so we take the larger of the two sides.
   */
  async getReceivedProceeds(txHash, wallet, mode = 'sell') {
    if (!txHash || !wallet) return 0;
    const ethSide = await this.getPriceFromTrace(txHash, wallet, mode);
    const tokenSide = await this.getWethPriceFromTx(txHash, wallet, mode);
    return Math.max(ethSide || 0, tokenSide || 0);
  }

  /**
   * Try to detect NFT buy/mint price.
   * Returns { price, label, detected } where detected=false means we couldn't find it.
   */
  async detectBuyPrice(wallet, contract, tokenId) {
    const normalizedWallet = wallet.toLowerCase();

    // Get NFT transfers for this token
    const transfers = await this.rpcRequest('alchemy_getAssetTransfers', [{
      fromBlock: '0x0',
      toBlock: 'latest',
      toAddress: normalizedWallet,
      contractAddresses: [contract],
      category: ['erc721', 'erc1155'],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x64'
    }]);

    if (!transfers || !Array.isArray(transfers.transfers)) {
      return { price: 0, label: 'BUY PRICE', detected: false };
    }

    const tokenIdNorm = this.normalizeTokenId(tokenId);
    const incoming = transfers.transfers.find(t => this.transferMatchesToken(t, tokenIdNorm));

    if (!incoming) {
      return { price: 0, label: 'BUY PRICE', detected: false };
    }

    const isMint = incoming.from === '0x0000000000000000000000000000000000000000';
    const txHash = incoming.hash;

    const txValue = await this.getTxEthValue(txHash);

    // For mints: tx value of 0 means free mint
    if (isMint) {
      // Divide by batch count (e.g. batch-minting multiple NFTs in one tx)
      const batchCount = await this.countNftsReceivedInTx(txHash, wallet, contract);
      return { price: txValue / batchCount, label: 'MINT PRICE', detected: true };
    }

    // For secondary buys: detect the price then split by batch count
    const PROTOCOL_FEE_THRESHOLD = 0.005;

    let rawPrice = 0;

    if (txValue > PROTOCOL_FEE_THRESHOLD) {
      const wethValue = await this.getWethPriceFromTx(txHash, wallet, 'buy');
      rawPrice = Math.max(txValue, wethValue);
    } else {
      // Low tx.value → paid in WETH/Blur pool or via an internal transfer.
      // NOTE: never use incoming.value here — for erc721/erc1155 transfers that
      // field is the token QUANTITY, not an ETH price.
      let price = await this.getPriceFromTrace(txHash, wallet, 'buy');
      if (price >= 0.0001) {
        const wethValue = await this.getWethPriceFromTx(txHash, wallet, 'buy');
        rawPrice = Math.max(price, wethValue);
      } else {
        price = await this.getWethPriceFromTx(txHash, wallet, 'buy');
        if (price > 0) {
          rawPrice = price;
        } else if (txValue > 0) {
          rawPrice = txValue;
        }
      }
    }

    if (rawPrice > 0) {
      // Split price equally if multiple NFTs from same collection bought in one tx
      const batchCount = await this.countNftsReceivedInTx(txHash, wallet, contract);
      const perNftPrice = rawPrice / batchCount;
      if (batchCount > 1) console.log(`[Buy] Batch of ${batchCount}: ${rawPrice.toFixed(4)} / ${batchCount} = ${perNftPrice.toFixed(4)} ETH`);
      return { price: perNftPrice, label: 'BUY PRICE', detected: true };
    }

    // No payment found — check if this was a P2P transfer/gift
    const txSender = await this.rpcRequest('eth_getTransactionByHash', [txHash])
      .then(tx => tx?.from?.toLowerCase()).catch(() => null);
    if (txSender && txSender !== normalizedWallet) {
      console.log(`[Buy] NFT was transferred/gifted from ${txSender} — no payment on-chain`);
      return { price: 0, label: 'TRANSFERRED', detected: true };
    }

    console.log(`[Buy] Could not detect price for ${txHash}`);
    return { price: 0, label: 'BUY PRICE', detected: false };
  }

  /**
   * Try to detect NFT sell price.
   * Returns { price, detected }
   */
  async detectSellPrice(wallet, contract, tokenId) {
    const normalizedWallet = wallet.toLowerCase();

    const transfers = await this.rpcRequest('alchemy_getAssetTransfers', [{
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: normalizedWallet,
      contractAddresses: [contract],
      category: ['erc721', 'erc1155'],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x64'
    }]);

    if (!transfers || !Array.isArray(transfers.transfers)) {
      return { price: 0, detected: false };
    }

    const tokenIdNorm = this.normalizeTokenId(tokenId);
    const outgoing = transfers.transfers.find(t => this.transferMatchesToken(t, tokenIdNorm));

    if (!outgoing) {
      return { price: 0, detected: false };
    }

    // Net proceeds the seller actually RECEIVED (ETH + WETH/Blur pool), after
    // marketplace fee + royalty — not the gross buyer-side tx.value. Fall back to
    // gross tx.value only when no received-value can be traced (older txns).
    let rawPrice = await this.getReceivedProceeds(outgoing.hash, wallet, 'sell');
    if (rawPrice <= 0) rawPrice = await this.getTxEthValue(outgoing.hash);

    if (rawPrice > 0) {
      // Split proceeds if multiple NFTs from same collection sold in one tx
      const batchCount = await this.countNftsInTx(outgoing.hash, wallet, contract, 'from');
      const perNftPrice = rawPrice / batchCount;
      if (batchCount > 1) console.log(`[Sell] Batch of ${batchCount}: ${rawPrice.toFixed(4)} / ${batchCount} = ${perNftPrice.toFixed(4)} ETH`);
      return { price: perNftPrice, detected: true };
    }

    return { price: 0, detected: false };
  }

  async getRecentOwnedNfts(wallet, limit = 3) {
    const keyError = this.checkKey();
    if (keyError) return keyError;

    const data = await this.request(`${this.nftBaseUrl}/getNFTsForOwner`, {
      owner: wallet,
      withMetadata: true,
      orderBy: 'transferTime',
      pageSize: 100
    });

    if (!data || !Array.isArray(data.ownedNfts)) {
      return { error: 'Failed to fetch NFTs.' };
    }

    const nfts = data.ownedNfts
      .map(nft => {
        const contract = nft.contract || {};
        const formattedId = this.formatTokenId(nft.tokenId);
        return {
          contract: contract.address || '',
          tokenId: nft.tokenId,
          name: nft.name || `${contract.name || 'NFT'} #${formattedId}`,
          image: nft.image?.cachedUrl || contract.openSeaMetadata?.imageUrl || '',
          collectionName: contract.name || contract.openSeaMetadata?.collectionName || 'Unknown',
          floorPrice: contract.openSeaMetadata?.floorPrice || 0,
          acquiredAt: nft.acquiredAt?.blockTimestamp || null
        };
      })
      .filter(nft => !this.isSpamNft(nft.name))
      .slice(0, limit);

    return { nfts };
  }

  async getRecentSoldNfts(wallet, limit = 3) {
    const keyError = this.checkKey();
    if (keyError) return keyError;

    const normalizedWallet = wallet.toLowerCase();

    const outgoing = await this.rpcRequest('alchemy_getAssetTransfers', [{
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: normalizedWallet,
      category: ['erc721', 'erc1155'],
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x64'
    }]);

    if (!outgoing || !Array.isArray(outgoing.transfers) || outgoing.transfers.length === 0) {
      return { nfts: [] };
    }

    const sorted = outgoing.transfers
      .sort((a, b) => parseInt(b.blockNum, 16) - parseInt(a.blockNum, 16));

    const seen = new Set();
    const unique = [];
    for (const t of sorted) {
      const contract = t.rawContract?.address || '';
      const tokenId = this.getTransferTokenId(t);
      const key = `${contract}:${tokenId}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(t);
        if (unique.length >= limit * 2) break;
      }
    }

    const nfts = [];
    for (const t of unique) {
      const contract = t.rawContract?.address || '';
      const tokenId = this.getTransferTokenId(t);

      const meta = await this.request(`${this.nftBaseUrl}/getNFTMetadata`, {
        contractAddress: contract,
        tokenId
      });

      const name = meta?.name || `${meta?.contract?.name || 'NFT'} #${this.formatTokenId(tokenId)}`;
      if (this.isSpamNft(name)) continue;

      nfts.push({
        contract,
        tokenId,
        name,
        image: meta?.image?.cachedUrl || meta?.contract?.openSeaMetadata?.imageUrl || '',
        collectionName: meta?.contract?.name || meta?.contract?.openSeaMetadata?.collectionName || 'Unknown',
        sellPrice: 0, // preview only — t.value is the token quantity, not an ETH price; real proceeds resolved on click
        sellTime: t.metadata?.blockTimestamp || null
      });

      if (nfts.length >= limit) break;
    }

    return { nfts };
  }

  async analyzeNft(wallet, contract, tokenId, mode = 'hold') {
    const keyError = this.checkKey();
    if (keyError) return keyError;

    const normalizedWallet = wallet.toLowerCase();

    const meta = await this.request(`${this.nftBaseUrl}/getNFTMetadata`, {
      contractAddress: contract,
      tokenId
    });

    const collectionName = meta?.contract?.name || meta?.contract?.openSeaMetadata?.collectionName || 'Unknown';
    const image = meta?.image?.cachedUrl || meta?.contract?.openSeaMetadata?.imageUrl || '';

    const buyInfo = await this.detectBuyPrice(normalizedWallet, contract, tokenId);

    if (mode === 'sold') {
      const sellInfo = await this.detectSellPrice(normalizedWallet, contract, tokenId);

      return {
        mode: 'realized',
        collection: collectionName,
        collectionImage: image,
        tokenName: meta?.name || `${collectionName} #${this.formatTokenId(tokenId)}`,
        tokenImage: image,
        tokenId,
        contract,
        buyPrice: buyInfo.price,
        buyDetected: buyInfo.detected,
        entryLabel: buyInfo.label,
        sellPrice: sellInfo.price,
        sellDetected: sellInfo.detected,
        currency: 'ETH',
        wallet: normalizedWallet,
        error: null
      };
    }

    const liveFloor = await this.getCollectionFloorPrice(contract);
    const saleFee = await this.getCollectionSaleFeeRate(contract);
    const saleFeeRate = saleFee.rate || 0;
    const netFloor = liveFloor > 0 ? liveFloor * (1 - saleFeeRate) : 0;
    if (liveFloor > 0) {
      console.log(
        `[PnL] Single NFT floor: gross ${liveFloor.toFixed(4)} ETH, ` +
        `sale deductions ${(saleFeeRate * 100).toFixed(2)}% (${saleFee.samples || 0} samples), ` +
        `net ${netFloor.toFixed(4)} ETH`
      );
    }

    return {
      mode: 'unrealized',
      collection: collectionName,
      collectionImage: image,
      tokenName: meta?.name || `${collectionName} #${this.formatTokenId(tokenId)}`,
      tokenImage: image,
      tokenId,
      contract,
      buyPrice: buyInfo.price,
      buyDetected: buyInfo.detected,
      entryLabel: buyInfo.label,
      currentValue: netFloor,
      grossFloor: liveFloor,
      saleFeeRate,
      floorDetected: netFloor > 0.00001,
      currency: 'ETH',
      wallet: normalizedWallet,
      error: null
    };
  }

  /**
   * Calculate gas fees for a transaction.
   */
  async getGasFees(txHash) {
    if (!txHash) return 0;
    try {
      const [receipt, tx] = await Promise.all([
        this.rpcRequest('eth_getTransactionReceipt', [txHash]),
        this.rpcRequest('eth_getTransactionByHash', [txHash])
      ]);
      if (!receipt || !tx) return 0;
      const gasUsed = parseInt(receipt.gasUsed, 16);
      const gasPrice = parseInt(tx.gasPrice, 16);
      if (isNaN(gasUsed) || isNaN(gasPrice)) return 0;
      return (gasUsed * gasPrice) / 1e18;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Resolve the acquisition cost basis for an NFT from its buy history.
   * - Free mints (MINT PRICE, 0 ETH paid): the cost is the gas (mint fee), labelled "MINT FEE".
   *   Gas is the whole cost basis, so profit must not subtract it again (extraGas = 0).
   * - Paid buys/mints: buyPrice is the price; gas is subtracted separately (extraGas = gas).
   * Gas is split across NFTs minted/bought in the same tx (batch).
   * Returns { buyPrice, buyLabel, gasFees, extraGas }.
   */
  async resolveBuyCost(history, wallet, contract) {
    const txHash = history.buy.txHash;
    let gas = await this.getGasFees(txHash);
    if (gas > 0 && txHash) {
      const batch = await this.countNftsInTx(txHash, wallet, contract, 'to');
      if (batch > 1) gas = gas / batch;
    }
    const isFreeMint = history.buy.detected
      && history.buy.label === 'MINT PRICE'
      && (history.buy.price || 0) <= 0;
    if (isFreeMint && gas > 0) {
      return { buyPrice: gas, buyLabel: 'MINT FEE', gasFees: gas, extraGas: 0 };
    }
    return { buyPrice: history.buy.price, buyLabel: history.buy.label, gasFees: gas, extraGas: gas };
  }

  /**
   * Format hold time between two timestamps.
   */
  formatHoldTime(buyTimestamp, sellTimestamp) {
    if (!buyTimestamp) return 'Unknown';
    const buy = new Date(buyTimestamp);
    const sell = sellTimestamp ? new Date(sellTimestamp) : new Date();
    const diffMs = sell - buy;
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 365) {
      return `${(days / 365).toFixed(1)}y`;
    }
    if (days > 30) {
      return `${Math.floor(days / 30)}mo ${days % 30}d`;
    }
    return `${days}d ${hours}h`;
  }

  /**
   * Parse OpenSea URL or contract address.
   * Returns { contract, tokenId } or { slug } or null.
   */
  parseOpenSeaUrl(url) {
    if (!url) return null;
    const trimmed = url.trim();
    // Direct contract address
    if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      return { contract: trimmed.toLowerCase() };
    }
    try {
      // https://opensea.io/assets/ethereum/0xCONTRACT/TOKENID
      const assetMatch = trimmed.match(/opensea\.io\/assets\/ethereum\/(0x[a-fA-F0-9]{40})\/(\d+)/i);
      if (assetMatch) {
        return { contract: assetMatch[1].toLowerCase(), tokenId: assetMatch[2] };
      }
      // https://opensea.io/collection/slug
      const collectionMatch = trimmed.match(/opensea\.io\/collection\/([a-zA-Z0-9_-]+)/i);
      if (collectionMatch) {
        return { slug: collectionMatch[1] };
      }
    } catch (e) {}
    return null;
  }

  /**
   * Fetch live floor price for a collection, with a multi-source fallback chain:
   * 1. Alchemy floor/metadata using the paid Alchemy key.
   * 2. Reservoir public API (no OpenSea key required).
   * 3. OpenSea API (accurate but key/rate-limit dependent).
   * 4. Estimate from recent on-chain sales via getNFTSales.
   * Returns 0 only if no source has data.
   */
  async getCollectionFloorPrice(contract) {
    if (!this.hasKey) return 0;

    // Serve from cache if fresh
    const cached = this.floorCache.get(contract.toLowerCase());
    if (cached && Date.now() - cached.ts < this.floorCacheTtl) return cached.floor;

    let floor = 0;

    // 1. Alchemy paid API floor/metadata
    try {
      floor = await this.getAlchemyFloor(contract);
    } catch (e) { /* fall through */ }

    // 2. Reservoir public API (no OpenSea key required)
    if (floor <= 0) {
      try {
        floor = await this.getReservoirFloor(contract);
      } catch (e) { /* fall through */ }
    }

    // 3. OpenSea (accurate but key/rate-limit dependent)
    if (floor <= 0) {
      try {
        floor = await this.getOpenSeaFloor(contract);
      } catch (e) { /* fall through */ }
    }

    // 4. Recent-sales estimate
    if (floor <= 0) {
      floor = await this.estimateFloorFromSales(contract);
    }

    this.floorCache.set(contract.toLowerCase(), { floor, ts: Date.now() });
    return floor;
  }

  /**
   * Estimate forced sale deductions from recent sales.
   * Returns the marketplace + royalty rate that should be subtracted from
   * unrealized floor value. Real sold NFTs use traced wallet proceeds instead.
   */
  async getCollectionSaleFeeRate(contract) {
    const lc = contract.toLowerCase();
    const cached = this.saleFeeCache.get(lc);
    if (cached && Date.now() - cached.ts < this.floorCacheTtl) return cached;

    let totalGrossWei = 0;
    let totalFeeWei = 0;
    let samples = 0;

    try {
      const res = await this.request(`${this.nftBaseUrl}/getNFTSales`, {
        contractAddress: contract,
        order: 'desc',
        limit: 20
      });

      for (const s of res?.nftSales || []) {
        const seller = s.sellerFee?.amount ? parseInt(s.sellerFee.amount, 10) : 0;
        const protocol = s.protocolFee?.amount ? parseInt(s.protocolFee.amount, 10) : 0;
        const royalty = s.royaltyFee?.amount ? parseInt(s.royaltyFee.amount, 10) : 0;
        const gross = seller + protocol + royalty;
        const sym = s.sellerFee?.symbol;

        if (gross > 0 && (!sym || sym === 'ETH' || sym === 'WETH')) {
          totalGrossWei += gross;
          totalFeeWei += protocol + royalty;
          samples++;
        }
      }
    } catch (e) {
      // Fall through to a zero-rate result.
    }

    const rate = totalGrossWei > 0 ? totalFeeWei / totalGrossWei : 0;
    const safeRate = rate > 0 && rate < 0.5 ? rate : 0;
    const result = { rate: safeRate, samples, ts: Date.now() };
    this.saleFeeCache.set(lc, result);
    return result;
  }

  /**
   * Estimate a floor/value from recent marketplace sales when no listing floor exists.
   * Uses the lowest of the last ~20 sales as a conservative proxy. Returns 0 if none.
   */
  async estimateFloorFromSales(contract) {
    try {
      const res = await this.request(`${this.nftBaseUrl}/getNFTSales`, {
        contractAddress: contract,
        order: 'desc',
        limit: 20
      });
      const sales = res?.nftSales || [];
      if (sales.length === 0) return 0;
      const prices = [];
      for (const s of sales) {
        const seller = s.sellerFee?.amount ? parseInt(s.sellerFee.amount) : 0;
        const protocol = s.protocolFee?.amount ? parseInt(s.protocolFee.amount) : 0;
        const royalty = s.royaltyFee?.amount ? parseInt(s.royaltyFee.amount) : 0;
        const totalWei = seller + protocol + royalty;
        // Only count ETH/WETH-denominated sales
        const sym = s.sellerFee?.symbol;
        if (totalWei > 0 && (!sym || sym === 'ETH' || sym === 'WETH')) {
          prices.push(totalWei / 1e18);
        }
      }
      if (prices.length === 0) return 0;
      const floor = Math.min(...prices);
      console.log(`[Floor] ${contract.slice(0,10)} estimated ${floor.toFixed(4)} ETH from ${prices.length} recent sales`);
      return floor;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Get full buy/sell history for a single NFT including tx hashes and timestamps.
   */
  async getNftFullHistory(wallet, contract, tokenId) {
    const normalizedWallet = wallet.toLowerCase();

    // Incoming transfer (buy/mint)
    const incomingTransfers = await this.rpcRequest('alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest',
      toAddress: normalizedWallet,
      contractAddresses: [contract],
      category: ['erc721', 'erc1155'],
      withMetadata: true, excludeZeroValue: false, maxCount: '0x64'
    }]);

    const tokenIdNorm = this.normalizeTokenId(tokenId);
    const incoming = incomingTransfers?.transfers?.find(
      t => this.transferMatchesToken(t, tokenIdNorm)
    );

    // Outgoing transfer (sell)
    const outgoingTransfers = await this.rpcRequest('alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest',
      fromAddress: normalizedWallet,
      contractAddresses: [contract],
      category: ['erc721', 'erc1155'],
      withMetadata: true, excludeZeroValue: false, maxCount: '0x64'
    }]);

    const outgoing = outgoingTransfers?.transfers?.find(
      t => this.transferMatchesToken(t, tokenIdNorm)
    );

    // Detect buy price
    let buyPrice = 0, buyDetected = false, buyLabel = 'BUY PRICE';
    let buyTxHash = null, buyTime = null;
    const PROTOCOL_FEE_THRESHOLD = 0.005;

    if (incoming) {
      buyTxHash = incoming.hash;
      buyTime = incoming.metadata?.blockTimestamp;
      const isMint = incoming.from === '0x0000000000000000000000000000000000000000';
      buyLabel = isMint ? 'MINT PRICE' : 'BUY PRICE';

      const txValue = await this.getTxEthValue(incoming.hash);

      // Detect raw price using all methods
      let rawBuyPrice = 0;
      if (isMint) {
        rawBuyPrice = txValue;
      } else if (txValue > PROTOCOL_FEE_THRESHOLD) {
        const wethValue = await this.getWethPriceFromTx(incoming.hash, wallet, 'buy');
        rawBuyPrice = Math.max(txValue, wethValue);
      } else {
        let price = await this.getPriceFromTrace(incoming.hash, wallet, 'buy');
        if (price >= 0.0001) {
          const wethValue = await this.getWethPriceFromTx(incoming.hash, wallet, 'buy');
          rawBuyPrice = Math.max(price, wethValue);
        } else {
          price = await this.getWethPriceFromTx(incoming.hash, wallet, 'buy');
          if (price > 0) rawBuyPrice = price;
          else if (txValue > 0) rawBuyPrice = txValue;
        }
      }

      if (rawBuyPrice > 0) {
        // Split if multiple NFTs from same collection bought in one tx
        const batchCount = await this.countNftsReceivedInTx(incoming.hash, normalizedWallet, contract);
        buyPrice = rawBuyPrice / batchCount;
        buyDetected = true;
        if (batchCount > 1) console.log(`[History] Batch ${batchCount}: ${rawBuyPrice.toFixed(4)}/${batchCount}=${buyPrice.toFixed(4)} ETH`);
      } else if (!isMint) {
        // Check if P2P transfer/gift
        const txSender = await this.rpcRequest('eth_getTransactionByHash', [incoming.hash])
          .then(t => t?.from?.toLowerCase()).catch(() => null);
        if (txSender && txSender !== normalizedWallet) {
          buyLabel = 'TRANSFERRED'; buyDetected = true;
        }
      } else {
        buyDetected = true; // free mint, price = 0
      }
    }

    // Detect sell price
    let sellPrice = 0, sellDetected = false;
    let sellTxHash = null, sellTime = null;

    if (outgoing) {
      sellTxHash = outgoing.hash;
      sellTime = outgoing.metadata?.blockTimestamp;
      // Net proceeds the seller received (ETH + WETH/Blur pool), after fee + royalty.
      // Gross tx.value is only a last-resort fallback (overstates by the fees).
      let rawSellPrice = await this.getReceivedProceeds(outgoing.hash, wallet, 'sell');
      if (rawSellPrice <= 0) rawSellPrice = await this.getTxEthValue(outgoing.hash);
      if (rawSellPrice > 0) {
        // Split proceeds if multiple NFTs from same collection sold in one tx
        const batchCount = await this.countNftsInTx(outgoing.hash, wallet, contract, 'from');
        sellPrice = rawSellPrice / batchCount;
        sellDetected = true;
        if (batchCount > 1) console.log(`[History] Sell batch ${batchCount}: ${rawSellPrice.toFixed(4)}/${batchCount}=${sellPrice.toFixed(4)} ETH`);
      }
    }

    return {
      buy: { price: buyPrice, detected: buyDetected, label: buyLabel, txHash: buyTxHash, timestamp: buyTime },
      sell: { price: sellPrice, detected: sellDetected, txHash: sellTxHash, timestamp: sellTime }
    };
  }

  /**
   * Get sold NFTs for a specific collection.
   */
  async getRecentSoldNftsForCollection(wallet, contract) {
    const normalizedWallet = wallet.toLowerCase();

    const outgoing = await this.rpcRequest('alchemy_getAssetTransfers', [{
      fromBlock: '0x0', toBlock: 'latest',
      fromAddress: normalizedWallet,
      contractAddresses: [contract],
      category: ['erc721', 'erc1155'],
      withMetadata: true, excludeZeroValue: false,
      maxCount: '0x64'
    }]);

    if (!outgoing || !Array.isArray(outgoing.transfers)) return [];

    const sorted = outgoing.transfers.sort((a, b) => parseInt(b.blockNum, 16) - parseInt(a.blockNum, 16));
    const seen = new Set();
    const unique = [];
    for (const t of sorted) {
      const tid = this.getTransferTokenId(t);
      if (!seen.has(tid)) {
        seen.add(tid);
        unique.push(t);
      }
    }

    const nfts = [];
    for (const t of unique.slice(0, 20)) {
      const realTokenId = this.getTransferTokenId(t);
      const meta = await this.request(`${this.nftBaseUrl}/getNFTMetadata`, {
        contractAddress: contract,
        tokenId: realTokenId
      });
      const name = meta?.name || `${meta?.contract?.name || 'NFT'} #${this.formatTokenId(realTokenId)}`;
      if (this.isSpamNft(name)) continue;
      nfts.push({
        contract,
        tokenId: realTokenId,
        name,
        image: meta?.image?.cachedUrl || meta?.contract?.openSeaMetadata?.imageUrl || '',
        collectionName: meta?.contract?.name || meta?.contract?.openSeaMetadata?.collectionName || 'Unknown',
        sellPrice: 0, // preview only — t.value is the token quantity, not an ETH price; real proceeds resolved on click
        sellTime: t.metadata?.blockTimestamp || null
      });
    }
    return nfts;
  }

  /**
   * Verify a contract exists as an NFT collection on Ethereum mainnet.
   * Returns { valid, reason } — reason explains the failure for a user-facing message.
   */
  async validateContract(contract) {
    const meta = await this.request(`${this.nftBaseUrl}/getContractMetadata`, { contractAddress: contract });
    if (!meta) return { valid: false, reason: 'lookup_failed' };
    if (meta.tokenType === 'NOT_A_CONTRACT') {
      return { valid: false, reason: 'not_a_contract' };
    }
    if (meta.tokenType === 'ERC721' || meta.tokenType === 'ERC1155') {
      return {
        valid: true,
        tokenType: meta.tokenType,
        name: meta.name || meta.openSeaMetadata?.collectionName,
        floorPrice: this.extractAlchemyFloor(meta)
      };
    }
    // Alchemy sometimes returns UNKNOWN for valid NFT contracts with non-standard interfaces.
    // Fall back to OpenSea: if it resolves to a collection slug, treat it as valid.
    const osData = await this.openSeaGet(`chain/ethereum/contract/${contract}`);
    if (osData?.collection) {
      const tokenType = meta.tokenType || 'UNKNOWN';
      console.log(`[Validate] Alchemy said ${tokenType} but OpenSea confirms collection: ${osData.collection}`);
      return { valid: true, tokenType, name: osData.collection };
    }
    return { valid: false, reason: 'not_an_nft', tokenType: meta.tokenType };
  }

  /**
   * Analyze full PnL for all NFTs in a collection.
   * Returns array of PnL objects with gas, hold time, profit.
   */
  async analyzeCollectionPnL(wallet, contract) {
    const keyError = this.checkKey();
    if (keyError) return [keyError];

    const normalizedWallet = wallet.toLowerCase();
    const t0 = Date.now();
    console.log(`\n[PnL] ── Analyzing ${contract} for ${wallet} ──`);

    // Validate the contract exists on Ethereum mainnet first
    const validation = await this.validateContract(contract);
    if (!validation.valid) {
      let error;
      if (validation.reason === 'not_a_contract') {
        error = `**Not an Ethereum NFT collection.**\nThe address \`${contract}\` has no contract code on Ethereum mainnet. It may be a collection on another chain (Base, Polygon, Arbitrum…), which this bot doesn't support yet.`;
      } else if (validation.reason === 'not_an_nft') {
        error = `**Not an NFT collection.**\nThe address \`${contract}\` is a \`${validation.tokenType}\` contract, not an ERC-721/1155 NFT collection.`;
      } else {
        error = `**Could not verify collection.**\nCouldn't look up \`${contract}\` on Ethereum. Double-check the address and try again.`;
      }
      console.log(`[PnL] ✗ Invalid contract (${validation.reason}) — aborting`);
      return [{ error }];
    }
    console.log(`[PnL] ✓ Contract valid: ${validation.name || '(unnamed)'} (${validation.tokenType})`);

    // Get owned NFTs from this collection
    const ownedData = await this.request(`${this.nftBaseUrl}/getNFTsForOwner`, {
      owner: wallet,
      contractAddresses: [contract],
      withMetadata: true,
      pageSize: 100
    });
    console.log(`[PnL] Held in wallet: ${ownedData?.ownedNfts?.length || 0}`);

    // Get sold NFTs from this collection
    const soldNfts = await this.getRecentSoldNftsForCollection(wallet, contract);
    console.log(`[PnL] Outgoing (sold/transferred) found: ${soldNfts.length}`);

    // Fetch live floor price once for the whole collection
    let liveFloorPrice = await this.getCollectionFloorPrice(contract);
    if (liveFloorPrice <= 0 && validation.floorPrice > 0) {
      liveFloorPrice = validation.floorPrice;
      this.floorCache.set(contract.toLowerCase(), { floor: liveFloorPrice, ts: Date.now() });
      console.log(`[Floor] Alchemy validation metadata floor fallback: ${liveFloorPrice.toFixed(4)} ETH`);
    }
    if (liveFloorPrice <= 0) {
      const metadataFloors = (ownedData?.ownedNfts || [])
        .map(nft => Number(nft.contract?.openSeaMetadata?.floorPrice) || 0)
        .filter(floor => floor > 0.00001);
      if (metadataFloors.length > 0) {
        liveFloorPrice = Math.min(...metadataFloors);
        this.floorCache.set(contract.toLowerCase(), { floor: liveFloorPrice, ts: Date.now() });
        console.log(`[Floor] Alchemy metadata floor fallback: ${liveFloorPrice.toFixed(4)} ETH`);
      }
    }
    const saleFee = await this.getCollectionSaleFeeRate(contract);
    const saleFeeRate = saleFee.rate || 0;
    const netFloorPrice = liveFloorPrice > 0 ? liveFloorPrice * (1 - saleFeeRate) : 0;
    console.log(`[PnL] Floor price: ${liveFloorPrice > 0 ? liveFloorPrice.toFixed(4) + ' ETH' : 'N/A (no source)'}`);
    if (liveFloorPrice > 0) {
      console.log(
        `[PnL] Estimated sale deductions: ${(saleFeeRate * 100).toFixed(2)}% ` +
        `(${saleFee.samples || 0} recent sale samples) => net floor ${netFloorPrice.toFixed(4)} ETH`
      );
    }

    const results = [];
    const seenTokenIds = new Set();

    // Process owned NFTs
    for (const nft of ownedData?.ownedNfts || []) {
      const normId = this.normalizeTokenId(nft.tokenId);
      if (seenTokenIds.has(normId)) continue;
      seenTokenIds.add(normId);

      const history = await this.getNftFullHistory(wallet, contract, nft.tokenId);
      const collectionName = nft.contract?.name || nft.contract?.openSeaMetadata?.collectionName || 'Unknown';
      const image = nft.image?.cachedUrl || nft.contract?.openSeaMetadata?.imageUrl || '';
      const floorPrice = netFloorPrice;

      // Resolve the acquisition cost basis (handles free mints → gas/mint fee)
      const cost = await this.resolveBuyCost(history, wallet, contract);

      // Calculate profit if floor is known. If buy undetected, treat cost as 0 (can't know true P&L).
      let profit = null;
      let profitPercent = null;
      if (floorPrice > 0.00001) {
        const buyCost = history.buy.detected ? cost.buyPrice : 0;
        profit = floorPrice - buyCost - cost.extraGas;
        profitPercent = buyCost > 0 ? ((profit / buyCost) * 100) : (profit > 0 ? Infinity : 0);
      }

      results.push({
        tokenName: nft.name || `${collectionName} #${this.formatTokenId(nft.tokenId)}`,
        tokenImage: image,
        tokenId: nft.tokenId,
        collection: collectionName,
        mode: 'holding',
        wallet: normalizedWallet,
        buyPrice: cost.buyPrice,
        buyDetected: history.buy.detected,
        buyLabel: cost.buyLabel,
        buyTxHash: history.buy.txHash,
        buyTime: history.buy.timestamp,
        sellPrice: 0,
        sellDetected: false,
        sellTxHash: null,
        sellTime: null,
        currentFloor: floorPrice,
        grossFloor: liveFloorPrice,
        saleFeeRate,
        gasFees: cost.gasFees,
        buyExtraGas: cost.extraGas, // 0 for free mints (gas is already in buyPrice); >0 for paid buys
        holdTime: this.formatHoldTime(history.buy.timestamp, null),
        profit,
        profitPercent
      });
    }

    // Process sold NFTs
    for (const nft of soldNfts) {
      const normId = this.normalizeTokenId(nft.tokenId);
      if (seenTokenIds.has(normId)) continue;
      seenTokenIds.add(normId);

      const history = await this.getNftFullHistory(wallet, contract, nft.tokenId);
      const cost = await this.resolveBuyCost(history, wallet, contract);
      const sellGas = await this.getGasFees(history.sell.txHash);
      const totalGas = cost.gasFees + sellGas;

      // Distinguish a genuine sale (proceeds detected) from a plain transfer out
      // (e.g. moved to another wallet / staking). Transfers have no proceeds and
      // are excluded from P&L by the caller.
      const isRealSale = history.sell.detected && history.sell.price > 0.00001;

      // Only calculate profit for genuine sales where the buy leg is known.
      // cost.buyPrice already folds in the mint fee for free mints (extraGas=0 then).
      let profit = null;
      let profitPercent = null;
      if (isRealSale && history.buy.detected) {
        profit = history.sell.price - cost.buyPrice - cost.extraGas - sellGas;
        profitPercent = cost.buyPrice > 0 ? ((profit / cost.buyPrice) * 100) : (profit > 0 ? Infinity : 0);
      }

      results.push({
        tokenName: nft.name,
        tokenImage: nft.image,
        tokenId: nft.tokenId,
        collection: nft.collectionName,
        mode: isRealSale ? 'sold' : 'transferred_out',
        wallet: normalizedWallet,
        buyPrice: cost.buyPrice,
        buyDetected: history.buy.detected,
        buyLabel: cost.buyLabel,
        buyTxHash: history.buy.txHash,
        buyTime: history.buy.timestamp,
        sellPrice: history.sell.price,
        sellDetected: history.sell.detected,
        sellTxHash: history.sell.txHash,
        sellTime: history.sell.timestamp,
        currentFloor: 0,
        gasFees: totalGas,
        buyExtraGas: cost.extraGas, // 0 for free mints; >0 for paid buys
        holdTime: this.formatHoldTime(history.buy.timestamp, history.sell.timestamp),
        profit,
        profitPercent
      });
    }

    const held = results.filter(r => r.mode === 'holding').length;
    const realSold = results.filter(r => r.mode === 'sold').length;
    const movedOut = results.filter(r => r.mode === 'transferred_out').length;
    console.log(`[PnL] ✓ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — rows: ${results.length} (held ${held}, sold ${realSold}, moved out ${movedOut})\n`);

    return results;
  }
}

module.exports = NftApiClient;
