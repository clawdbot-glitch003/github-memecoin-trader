import axios, { type AxiosRequestConfig } from 'axios';
import 'dotenv/config';

// ----------------------
// Interfaces
// ----------------------

interface Token {
  address: string;
  symbol: string;
  repo: string;
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

interface DexScreenerToken {
  address: string;
  name: string;
  symbol: string;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceNative: string;
  priceUsd: string;
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv: number;
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[];
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
      throw e;
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

  public async swap(tokenAddress: string, amountInEth: number): Promise<any> {
    // 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE represents native ETH
    const sellToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    
    // Check if DRY_RUN is enabled
    if (process.env.DRY_RUN === 'true') {
      console.log(`[DRY RUN] Would swap ${amountInEth} ETH for ${tokenAddress}`);
      return { status: 'simulated', txHash: '0x_simulated_hash' };
    }

    try {
      console.log(`Attempting to swap ${amountInEth} ETH for ${tokenAddress}...`);
      
      const body: SwapExecuteRequest = {
        sellToken,
        buyToken: tokenAddress,
        sellAmount: amountInEth.toString(),
        chainId: this.chainId,
        slippageBps: 200 // 2% slippage for volatility
      };

      const resp = await axios.post(
        `${this.baseUrl}/api/skills/evm-wallet/swap/execute`,
        body,
        { headers: this.getHeaders() }
      );

      console.log('Swap executed!', resp.data);
      return resp.data;
    } catch (e: any) {
      // Log basic error info but don't crash
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
    // Search for repos created in the last 7 days, sorted by stars
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
// Market Scanner (DexScreener)
// ----------------------

class MarketScanner {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = 'https://api.dexscreener.com/latest/dex';
  }

  public async searchToken(query: string): Promise<DexScreenerPair[]> {
    try {
      // DexScreener search endpoint
      const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
      const resp = await axios.get<DexScreenerResponse>(url);
      
      if (!resp.data || !resp.data.pairs) return [];
      
      // Filter strictly for Base chain
      return resp.data.pairs.filter(p => p.chainId === 'base');
    } catch (e: any) {
      console.error(`DexScreener API error for query "${query}":`, e.message);
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
  const marketScanner = new MarketScanner();
  const telegram = new TelegramNotifier();

  const isDryRun = process.env.DRY_RUN === 'true';

  console.log(`Starting Memecoin Trader (Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'})...`);
  await telegram.sendMessage(`🚀 *Memecoin Trader Started*\nMode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
  
  // 1. Get Wallet Info
  try {
    const address = await wallet.getAddress();
    console.log(`Wallet Address: ${address}`);
  } catch (error) {
    console.error('Failed to initialize wallet. Check your API key.');
    process.exit(1);
  }

  // 2. Scan GitHub for Trending Repos
  console.log('Scanning trending GitHub repos...');
  const repos = await githubScanner.getTrendingRepos();
  console.log(`Found ${repos.length} potential repos.`);

  const tokensToBuy: Token[] = [];

  for (const repo of repos) {
    console.log(`Checking market for repo: ${repo.name}...`);
    
    // Search DexScreener for tokens matching the repo name
    const pairs = await marketScanner.searchToken(repo.name);
    
    if (pairs.length > 0) {
      // Sort by liquidity (highest first)
      pairs.sort((a, b) => b.liquidity.usd - a.liquidity.usd);
      
      const bestPair = pairs[0];
      
      // Basic Safety Check: Minimum Liquidity $5k
      if (bestPair.liquidity.usd < 5000) {
        console.log(`  Skipping ${bestPair.baseToken.symbol}: Low liquidity ($${bestPair.liquidity.usd})`);
        continue;
      }

      console.log(`  Found matching token for ${repo.name}: ${bestPair.baseToken.symbol} (${bestPair.baseToken.address})`);
      console.log(`  Liquidity: $${bestPair.liquidity.usd}`);
      console.log(`  FDV: $${bestPair.fdv}`);
      
      const tokenInfo: Token = {
        address: bestPair.baseToken.address,
        symbol: bestPair.baseToken.symbol,
        repo: repo.name
      };

      await telegram.sendMessage(
        `🔍 *Opportunity Found*\n` +
        `Repo: [${repo.name}](${repo.html_url})\n` +
        `Token: ${tokenInfo.symbol}\n` +
        `Liquidity: $${bestPair.liquidity.usd.toLocaleString()}\n` + 
        `FDV: $${bestPair.fdv.toLocaleString()}\n` +
        `Address: \`${tokenInfo.address}\``
      );

      tokensToBuy.push(tokenInfo);
    }
    
    // Rate limit: 3 requests per second max for DexScreener (approx 300ms wait)
    await new Promise(r => setTimeout(r, 300));
  }

  if (tokensToBuy.length === 0) {
    console.log('No matching tokens found.');
    await telegram.sendMessage(`💤 No matching tokens found in this run.`);
    return;
  }

  // 3. Buy Strategy
  console.log(`\nAttempting to buy ${tokensToBuy.length} tokens...`);
  
  for (const token of tokensToBuy) {
    console.log(`Buying 0.0001 ETH of ${token.symbol} (${token.repo})...`);
    
    // Attempt the swap via Vincent Wallet
    const result = await wallet.swap(token.address, 0.0001); // excessive caution: very small test amount
    
    if (result) {
      await telegram.sendMessage(
        `💸 *Buy Executed (${isDryRun ? 'SIMULATED' : 'LIVE'})*\n` +
        `Token: ${token.symbol}\n` +
        `Amount: 0.0001 ETH\n` +
        `Status: ${isDryRun ? 'Simulated' : 'Submitted'}`
      );
    }
    
    // Wait to facilitate RPC/Wallet rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('Run complete.');
}

// Execute
main().catch(console.error);
