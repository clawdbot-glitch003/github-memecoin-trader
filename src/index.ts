import axios, { type AxiosRequestConfig } from 'axios';
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';

// ----------------------
// Interfaces
// ----------------------

interface Token {
  address: string;
  symbol: string;
  repo?: string;
  source: 'clanker';
}

interface TradeRecord {
  timestamp: string;
  symbol: string;
  address: string;
  source: string;
  action: 'buy' | 'sell_tp' | 'sell_sl';
  amount_eth: number;
  amount_token?: number;
  price_eth?: number;
  status: 'simulated' | 'executed' | 'failed';
  tx_hash?: string;
  repo?: string;
  pnl_usd?: number;
}

interface PortfolioState {
  cash_eth: number;
  positions: {
    [address: string]: {
      symbol: string;
      amount: number;
      entry_price_eth: number;
      pool_address?: string; // Stored to enable RPC price checks
    }
  };
}

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string;
  stargazers_count: number;
  html_url: string;
}

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepo[];
}

interface WalletAddressResponse {
  address: string;
}

interface WalletBalanceResponse {
  native: string;
  usd: number;
  tokens: any[];
}

interface SwapPreviewRequest {
  sellToken: string;
  buyToken: string;
  sellAmount: string; // in wei or human readable? Docs say "100" or "0.1" which implies human readable decimal
  chainId: number;
  slippageBps?: number;
}

interface SwapExecuteRequest extends SwapPreviewRequest {}

interface ClankerMarketData {
  market_cap?: number;
  market_cap_usd?: number;
  liquidity?: number;
  liquidity_usd?: number;
  volume_h24?: number;
}

interface ClankerToken { // Clanker API structure
  name: string;
  symbol: string;
  contract_address: string;
  created_at: string;
  tx_hash: string;
  pool_address?: string; // Essential for direct RPC check
  related?: {
    market?: ClankerMarketData;
  };
}

interface ClankerResponse {
  data: ClankerToken[];
  pagination: any;
}

// ----------------------
// Trade Logger (Local DB)
// ----------------------

class TradeLogger {
  private readonly logPath: string;

  constructor() {
    this.logPath = path.join(process.cwd(), 'trades.jsonl');
  }

  public log(record: TradeRecord): void {
    const line = JSON.stringify(record) + '\n';
    try {
      fs.appendFileSync(this.logPath, line, 'utf8');
      console.log(`[DB] Trade logged: ${record.symbol} (${record.action})`);
    } catch (e: any) {
      console.error('[DB] Failed to log trade:', e.message);
    }
  }
}

// ----------------------
// Portfolio Manager (Paper Trading)
// ----------------------

class PortfolioManager {
  private readonly dbPath: string;
  private state: PortfolioState;

  constructor() {
    this.dbPath = path.join(process.cwd(), 'portfolio.json');
    this.state = this.load();
  }

  private load(): PortfolioState {
    if (fs.existsSync(this.dbPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      } catch (e) {
        console.error('Failed to load portfolio, starting fresh.');
      }
    }
    // Default starting state: 1 ETH, no positions
    return { cash_eth: 1.0, positions: {} };
  }

  public save(): void {
    fs.writeFileSync(this.dbPath, JSON.stringify(this.state, null, 2));
  }

  public getBalance(): number {
    return this.state.cash_eth;
  }

  public canAfford(amountEth: number): boolean {
    return this.state.cash_eth >= amountEth;
  }

  public recordBuy(symbol: string, address: string, amountEth: number, amountToken: number, priceEth: number, poolAddress?: string): void {
    this.state.cash_eth -= amountEth;
    
    // Track position by address (unique key)
    if (!this.state.positions[address]) {
      this.state.positions[address] = { symbol, amount: 0, entry_price_eth: 0 };
    }
    
    const pos = this.state.positions[address];
    // Store pool address if available and not set
    if (poolAddress && !(pos as any).pool_address) {
      pos.pool_address = poolAddress;
    }
    
    // Update weighted average entry price
    const totalValue = (pos.amount * pos.entry_price_eth) + (amountToken * priceEth);
    const totalAmount = pos.amount + amountToken;
    
    if (totalAmount > 0) {
      pos.entry_price_eth = totalValue / totalAmount;
      pos.amount = totalAmount;
    }

    this.save();
    console.log(`[Portfolio] Bought ${amountToken.toFixed(2)} ${symbol} @ ${priceEth.toFixed(9)} ETH. Cash left: ${this.state.cash_eth.toFixed(4)} ETH`);
  }

  public recordSell(address: string, amountToken: number, executionPriceEth: number): void {
    const pos = this.state.positions[address];
    if (!pos) return;

    // Calculate proceeds
    const proceeds = amountToken * executionPriceEth;
    this.state.cash_eth += proceeds;
    
    // Reduce position
    pos.amount -= amountToken;
    if (pos.amount <= 1e-9) { // dust threshold
      delete this.state.positions[address];
    }

    this.save();
    console.log(`[Portfolio] Sold ${amountToken.toFixed(2)} ${pos.symbol} @ ${executionPriceEth.toFixed(9)} ETH. Cash increased to: ${this.state.cash_eth.toFixed(4)} ETH`);
  }
  
  public getPositions(): { address: string, symbol: string, amount: number, entry_price_eth: number, pool_address?: string }[] {
    return Object.entries(this.state.positions).map(([k, v]) => ({ address: k, ...v }));
  }
}

// ----------------------
// RPC Price Fetcher (Alchemy)
// ----------------------

class RpcPriceFetcher {
  private provider: ethers.JsonRpcProvider | null = null;

  constructor() {
    const apiKey = process.env.ALCHEMY_API_KEY;
    if (apiKey) {
      const url = `https://base-mainnet.g.alchemy.com/v2/${apiKey}`;
      this.provider = new ethers.JsonRpcProvider(url);
    } else if (process.env.BASE_RPC_URL) {
      this.provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
    } else {
      // console.warn('No Alchemy API Key or Base RPC URL provided. Price fetching will fail.');
    }
  }

  public isReady(): boolean {
    return this.provider !== null;
  }

  // Returns Price of Token in ETH
  async getPrice(poolAddress: string, tokenAddress: string): Promise<number | null> {
    if (!this.provider) return null;

    try {
      const poolContract = new ethers.Contract(poolAddress, [
        'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
        'function token0() external view returns (address)'
      ], this.provider);

      // Fetch slot0 (containing price) and token0 (to determine direction)
      const [sqrtPriceX96] = await poolContract.slot0();
      const token0 = await poolContract.token0();
      
      const isToken0 = tokenAddress.toLowerCase() === token0.toLowerCase();
      
      const numerator = Number(sqrtPriceX96);
      const denominator = 2 ** 96;
      const ratio = (numerator / denominator) ** 2; // price of token0 in terms of token1

      // if token is token0, price (in token1/ETH) = ratio
      // if token is token1, price (in token0/ETH) = 1 / ratio
      const priceInEth = isToken0 ? ratio : (1 / ratio);
      return priceInEth;

    } catch (e: any) {
      console.error(`[RPC] Price fetch failed for pool ${poolAddress}:`, e.message);
      return null;
    }
  }
}

// ----------------------
// Vincent Wallet Client
// ----------------------

class VincentWallet {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly chainId: number;

  constructor() {
    this.apiKey = process.env.API_KEY || '';
    this.baseUrl = process.env.BASE_URL || 'https://heyvincent.ai';
    this.chainId = parseInt(process.env.CHAIN_ID || '8453'); // Default to Base

    if (!this.apiKey) {
      throw new Error('Missing API_KEY in environment variables');
    }
  }

  private getHeaders(): AxiosRequestConfig['headers'] {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  public async getAddress(): Promise<string> {
    try {
      const resp = await axios.get<WalletAddressResponse>(
        `${this.baseUrl}/api/skills/evm-wallet/address`,
        { headers: this.getHeaders() }
      );
      return resp.data.address;
    } catch (e: any) {
      console.error('Error getting address:', e.message);
      return '';
    }
  }

  public async getBalances(): Promise<WalletBalanceResponse> {
    try {
      const resp = await axios.get<WalletBalanceResponse>(
        `${this.baseUrl}/api/skills/evm-wallet/balances`,
        {
          headers: this.getHeaders(),
          params: { chainIds: this.chainId }
        }
      );
      return resp.data;
    } catch (e: any) {
      console.error('Error getting balances:', e.message);
      throw e;
    }
  }

  async getQuote(tokenAddress: string, amountInEth: number): Promise<{ buyAmount: number, price: number } | null> {
    try {
      const sellToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
      const body: SwapPreviewRequest = {
        sellToken,
        buyToken: tokenAddress,
        sellAmount: BigInt(Math.floor(amountInEth * 1e18)).toString(),
        chainId: this.chainId,
        slippageBps: 100 // 1%
      };

      const resp = await axios.post<{ buyAmount: string }>(
        `${this.baseUrl}/api/skills/evm-wallet/swap/preview`,
        body,
        { headers: this.getHeaders() }
      );

      const amountOut = parseFloat(resp.data.buyAmount) / 1e18;
      const price = amountInEth / amountOut; // Price in ETH per Token

      return { buyAmount: amountOut, price };
    } catch (e: any) {
      // console.error(`[Wallet] Quote failed for ${tokenAddress}:`, e.message);
      return null;
    }
  }

  async getSellQuote(tokenAddress: string, tokenAmount: string): Promise<{ ethAmount: number, price: number } | null> {
    try {
      const sellToken = tokenAddress;
      const buyToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // ETH
      
      const body: SwapPreviewRequest = {
        sellToken,
        buyToken,
        sellAmount: tokenAmount, // exact token amount in WEI string
        chainId: this.chainId,
        slippageBps: 200 // 2% 
      };

      const resp = await axios.post<{ buyAmount: string }>(
        `${this.baseUrl}/api/skills/evm-wallet/swap/preview`,
        body,
        { headers: this.getHeaders() }
      );

      // Output is ETH (18 decimals)
      const ethAmount = parseFloat(resp.data.buyAmount) / 1e18;
      const amountIn = parseFloat(tokenAmount) / 1e18;
      const price = ethAmount / amountIn; // Price of 1 Token in ETH

      return { ethAmount, price };
    } catch (e: any) {
      return null;
    }
  }

  public async swap(tokenAddress: string, amountInEth: number): Promise<any> {
    const sellToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    
    // Check if DRY_RUN is enabled
    if (process.env.DRY_RUN === 'true') {
      try {
        console.log(`[DRY RUN] Getting quote for ${amountInEth} ETH -> ${tokenAddress}...`);
        
        const quote = await this.getQuote(tokenAddress, amountInEth);
        if (!quote) throw new Error('Failed to get quote');
        
        console.log(`[DRY RUN] Quote: ${quote.buyAmount.toFixed(2)} tokens @ ${quote.price.toFixed(9)} ETH`);
        return { status: 'simulated', txHash: '0x_simulated_hash', buyAmount: quote.buyAmount, price: quote.price };
      } catch (e: any) {
        console.error(`[DRY RUN] Quote failed:`, e.message);
        return { status: 'simulated', txHash: '0x_simulated_hash', buyAmount: 0, price: 0 };
      }
    }

    try {
      console.log(`Attempting to swap ${amountInEth} ETH for ${tokenAddress}...`);
      
      const body: SwapExecuteRequest = {
        sellToken,
        buyToken: tokenAddress,
        sellAmount: BigInt(Math.floor(amountInEth * 1e18)).toString(),
        chainId: this.chainId,
        slippageBps: 200 // 2% slippage
      };

      const resp = await axios.post(
        `${this.baseUrl}/api/skills/evm-wallet/swap/execute`,
        body,
        { headers: this.getHeaders() }
      );

      console.log('Swap executed!', resp.data);
      return resp.data;
    } catch (e: any) {
      console.error('Swap failed:', e.response?.data || e.message);
      return null;
    }
  }
}

// ----------------------
// GitHub Scanner
// ----------------------

class GitHubScanner {
  private readonly token: string;

  constructor() {
    this.token = process.env.GITHUB_TOKEN || '';
  }

  public async getTrendingRepos(): Promise<GitHubRepo[]> {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    const dateStr = date.toISOString().split('T')[0];
    
    const q = `created:>${dateStr} sort:stars`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&order=desc`;
    
    try {
      const headers: AxiosRequestConfig['headers'] = { 
        'User-Agent': 'Memecoin-Trader-Bot',
        'Accept': 'application/vnd.github.v3+json'
      };
      
      if (this.token) {
        headers['Authorization'] = `token ${this.token}`;
      }

      const resp = await axios.get<GitHubSearchResponse>(url, { headers });
      return resp.data.items || [];
    } catch (e: any) {
      console.error('GitHub API error:', e.message);
      return [];
    }
  }
}

// ----------------------
// Clanker Scanner
// ----------------------

class ClankerScanner {
  private readonly baseUrl = 'https://www.clanker.world/api/tokens';

  public async searchToken(query: string): Promise<ClankerToken[]> {
    try {
      const resp = await axios.get<ClankerResponse>(this.baseUrl, {
        params: {
          search: query, 
          q: query,
          chainId: 8453,
          sort: 'desc',
          limit: 5
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      let tokenList: ClankerToken[] = [];
      if (Array.isArray(resp.data)) {
        tokenList = resp.data;
      } else if (resp.data && Array.isArray((resp.data as any).data)) {
        tokenList = (resp.data as any).data;
      }
      return tokenList;
    } catch (e: any) {
      return [];
    }
  }
}

// ----------------------
// Telegram Notifier
// ----------------------

class TelegramNotifier {
  private readonly botToken: string;
  private readonly chatId: string;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
  }

  public async sendMessage(text: string): Promise<void> {
    if (process.env.ENABLE_TELEGRAM !== 'true') return;

    if (!this.botToken || !this.chatId) {
      console.log('[Telegram] No credentials, skipping message:', text);
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await axios.post(url, {
        chat_id: this.chatId,
        text: text,
        parse_mode: 'Markdown'
      });
    } catch (e: any) {
      console.error('[Telegram] Failed to send message:', e.message);
    }
  }
}

// ----------------------
// Main Application Logic
// ----------------------

async function main() {
  const wallet = new VincentWallet();
  const githubScanner = new GitHubScanner();
  const clankerScanner = new ClankerScanner();
  const telegram = new TelegramNotifier();
  const logger = new TradeLogger();
  const portfolio = new PortfolioManager();
  const rpc = new RpcPriceFetcher(); // Added
  
  const isDryRun = process.env.DRY_RUN === 'true';

  console.log(`Starting Memecoin Trader (Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'})...`);
  if (process.env.ENABLE_TELEGRAM === 'true') {
    await telegram.sendMessage(`🚀 *Memecoin Trader Started*\nMode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  }

  // Infinite loop for "every 10 minutes"
  while (true) {
    console.log(`\n--- Cycle Start (${new Date().toISOString()}) ---`);
    console.log(`[Portfolio] Cash: ${portfolio.getBalance().toFixed(4)} ETH. Positions: ${portfolio.getPositions().length}`);

    // 0. Update Prices & Check Stops (TP/SL)
    try {
      const portfolioPositions = portfolio.getPositions();
      if (portfolioPositions.length > 0) {
        console.log(`Checking ${portfolioPositions.length} positions for TP/SL...`);
        for (const pos of portfolioPositions) {
          
          let currentPrice = 0;
          let ethAmount = 0;

          // 1. Try Direct RPC (Best for new Clanker tokens)
          if (rpc.isReady()) {
             const poolAddress = pos.pool_address;
             if (poolAddress) {
               const rpcPrice = await rpc.getPrice(poolAddress, pos.address); 
               if (rpcPrice) {
                 currentPrice = rpcPrice;
                 ethAmount = pos.amount * currentPrice;
               }
             }
          } 
          
          // 2. Fallback to Wallet Quote
          if (currentPrice === 0) {
             const tokenAmountWei = BigInt(Math.floor(pos.amount * 1e18)).toString();
             const quote = await wallet.getSellQuote(pos.address, tokenAmountWei);
             if (quote) {
               currentPrice = quote.price;
               ethAmount = quote.ethAmount;
             }
          }
          
          if (currentPrice > 0) {
             const entryPrice = pos.entry_price_eth; // ETH per Token
             const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
             
             console.log(`  [Pos] ${pos.symbol}: Entry ${entryPrice.toFixed(9)} -> Current ${currentPrice.toFixed(9)} ETH (${pnlPercent.toFixed(2)}%)`);
             
             // TP: +50%, SL: -20%
             let action: 'sell_tp' | 'sell_sl' | null = null;
             if (pnlPercent >= 50) action = 'sell_tp';
             if (pnlPercent <= -20) action = 'sell_sl';
             
             if (action) {
                console.log(`  🚨 Triggering ${action === 'sell_tp' ? 'TAKE PROFIT' : 'STOP LOSS'} for ${pos.symbol}...`);
                portfolio.recordSell(pos.address, pos.amount, currentPrice);
                logger.log({
                  timestamp: new Date().toISOString(),
                  symbol: pos.symbol,
                  address: pos.address,
                  source: 'portfolio',
                  action: action,
                  amount_token: pos.amount,
                  amount_eth: ethAmount || (pos.amount * currentPrice), 
                  price_eth: currentPrice,
                  status: isDryRun ? 'simulated' : 'executed',
                  repo: 'portfolio_manager',
                  pnl_usd: 0 
               });
               
               await telegram.sendMessage(
                  `📉 *${action === 'sell_tp' ? 'Take Profit' : 'Stop Loss'} Executed*\n` +
                  `Token: ${pos.symbol}\n` +
                  `PnL: ${pnlPercent.toFixed(2)}%\n` +
                  `Price: ${currentPrice.toFixed(9)} ETH\n` +
                  `Proceeds: ${((ethAmount || 0)).toFixed(4)} ETH`
               );
             }
          }
          // Rate check
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch (e) {
      console.error('Portfolio update failed:', e);
    }

    // 1. Scan GitHub for NEW Opportunities
    if (!portfolio.canAfford(0.0001)) {
       console.log('Skipping GitHub scan: Not enough ETH for new buys (min 0.0001).');
    } else {
      console.log('Scanning trending GitHub repos...');
      const repos = await githubScanner.getTrendingRepos();
      
      for (const repo of repos) {
        // Clean repo name
        const cleanName = repo.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' ').toLowerCase();
        
        console.log(`Checking Clanker for repo: ${repo.name} (query: "${cleanName}")...`);
        const matchingTokens = await clankerScanner.searchToken(cleanName);
        
        if (matchingTokens.length > 0) {
          const bestMatch = matchingTokens[0];
          const createdAt = new Date(bestMatch.created_at).getTime();
          const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);

          // Filter: Freshness (< 7 days)
          if (ageHours > 7 * 24) {
            console.log(`  Skipping ${bestMatch.symbol}: Too old (${(ageHours/24).toFixed(1)} days)`);
            continue;
          }
          
          // Deduplication check (Portfolio)
          const existingPos = portfolio.getPositions().find(p => p.address === bestMatch.contract_address);
          if (existingPos) {
             console.log(`  Skipping ${bestMatch.symbol}: Already holding position.`);
             continue;
          }

          console.log(`  Found Opportunity: ${bestMatch.symbol} (${bestMatch.contract_address}). Age: ${(ageHours/24).toFixed(1)} days.`);

          // Buy
          const buyAmt = 0.0001; 
          console.log(`Buying ${buyAmt} ETH of ${bestMatch.symbol}...`);
          
          const result = await wallet.swap(bestMatch.contract_address, buyAmt);
          
          if (result) {
            const status = isDryRun ? 'simulated' : 'executed';
            let buyAmount = (result as any).buyAmount || 0;
            let priceEth = (result as any).price || 0;

            // If quote failed (0 amount) but we have RPC and pool address
            if (buyAmount === 0 && rpc.isReady() && bestMatch.pool_address) {
               console.log(`  [RPC] Fetching real-time price from pool ${bestMatch.pool_address}...`);
               const rpcPrice = await rpc.getPrice(bestMatch.pool_address, bestMatch.contract_address);
               if (rpcPrice) {
                 priceEth = rpcPrice;
                 buyAmount = buyAmt / priceEth; // Estimate tokens received
                 console.log(`  [RPC] Success! Price: ${priceEth.toFixed(9)} ETH. Est. Tokens: ${buyAmount.toFixed(2)}`);
               }
            }

            if (buyAmount > 0) {
              portfolio.recordBuy(bestMatch.symbol, bestMatch.contract_address, buyAmt, buyAmount, priceEth, bestMatch.pool_address);
            } else {
              console.log(`  [Warn] Failed to get price/amount for ${bestMatch.symbol}. Logging anyway but portfolio position will be empty.`);
            }

            logger.log({
              timestamp: new Date().toISOString(),
              symbol: bestMatch.symbol,
              address: bestMatch.contract_address,
              source: 'clanker',
              action: 'buy',
              amount_eth: buyAmt,
              amount_token: buyAmount,
              price_eth: priceEth,
              status: status,
              tx_hash: result.txHash,
              repo: repo.name
            });

            await telegram.sendMessage(
              `💸 *Buy Executed (${isDryRun ? 'SIMULATED' : 'LIVE'})*\n` +
              `Token: ${bestMatch.symbol}\n` +
              `Repo: ${repo.name}\n` + 
              `Entry: ${priceEth.toFixed(9)} ETH`
            );
          }
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Wait 10 minutes for next cycle
    console.log('[Cycle End] Waiting 10 minutes...');
    await new Promise(r => setTimeout(r, 10 * 60 * 1000));
  }
}

// Execute
main().catch(console.error);
