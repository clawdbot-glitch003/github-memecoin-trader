"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
// ----------------------
// Vincent Wallet Client
// ----------------------
class VincentWallet {
    apiKey;
    baseUrl;
    chainId;
    constructor() {
        this.apiKey = process.env.API_KEY || '';
        this.baseUrl = process.env.BASE_URL || 'https://heyvincent.ai';
        this.chainId = parseInt(process.env.CHAIN_ID || '8453'); // Default to Base
        if (!this.apiKey) {
            throw new Error('Missing API_KEY in environment variables');
        }
    }
    getHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };
    }
    async getAddress() {
        try {
            const resp = await axios_1.default.get(`${this.baseUrl}/api/skills/evm-wallet/address`, { headers: this.getHeaders() });
            return resp.data.address;
        }
        catch (e) {
            console.error('Error getting address:', e.message);
            throw e;
        }
    }
    async getBalances() {
        try {
            const resp = await axios_1.default.get(`${this.baseUrl}/api/skills/evm-wallet/balances`, {
                headers: this.getHeaders(),
                params: { chainIds: this.chainId }
            });
            return resp.data;
        }
        catch (e) {
            console.error('Error getting balances:', e.message);
            throw e;
        }
    }
    async swap(tokenAddress, amountInEth) {
        // 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE represents native ETH
        const sellToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
        try {
            console.log(`Attempting to swap ${amountInEth} ETH for ${tokenAddress}...`);
            const body = {
                sellToken,
                buyToken: tokenAddress,
                sellAmount: amountInEth.toString(),
                chainId: this.chainId,
                slippageBps: 200 // 2% slippage for volatility
            };
            const resp = await axios_1.default.post(`${this.baseUrl}/api/skills/evm-wallet/swap/execute`, body, { headers: this.getHeaders() });
            console.log('Swap executed!', resp.data);
            return resp.data;
        }
        catch (e) {
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
    token;
    constructor() {
        this.token = process.env.GITHUB_TOKEN || '';
    }
    async getTrendingRepos() {
        // Search for repos created in the last 7 days, sorted by stars
        const date = new Date();
        date.setDate(date.getDate() - 7);
        const dateStr = date.toISOString().split('T')[0];
        const q = `created:>${dateStr} sort:stars`;
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&order=desc`;
        try {
            const headers = {
                'User-Agent': 'Memecoin-Trader-Bot',
                'Accept': 'application/vnd.github.v3+json'
            };
            if (this.token) {
                headers['Authorization'] = `token ${this.token}`;
            }
            const resp = await axios_1.default.get(url, { headers });
            return resp.data.items || [];
        }
        catch (e) {
            console.error('GitHub API error:', e.message);
            return [];
        }
    }
}
// ----------------------
// Market Scanner (DexScreener)
// ----------------------
class MarketScanner {
    baseUrl;
    constructor() {
        this.baseUrl = 'https://api.dexscreener.com/latest/dex';
    }
    async searchToken(query) {
        try {
            // DexScreener search endpoint
            const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
            const resp = await axios_1.default.get(url);
            if (!resp.data || !resp.data.pairs)
                return [];
            // Filter strictly for Base chain
            return resp.data.pairs.filter(p => p.chainId === 'base');
        }
        catch (e) {
            console.error(`DexScreener API error for query "${query}":`, e.message);
            return [];
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
    console.log('Starting Memecoin Trader (TypeScript Edition)...');
    // 1. Get Wallet Info
    try {
        const address = await wallet.getAddress();
        console.log(`Wallet Address: ${address}`);
    }
    catch (error) {
        console.error('Failed to initialize wallet. Check your API key.');
        process.exit(1);
    }
    // 2. Scan GitHub for Trending Repos
    console.log('Scanning trending GitHub repos...');
    const repos = await githubScanner.getTrendingRepos();
    console.log(`Found ${repos.length} potential repos.`);
    const tokensToBuy = [];
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
            tokensToBuy.push({
                address: bestPair.baseToken.address,
                symbol: bestPair.baseToken.symbol,
                repo: repo.name
            });
        }
        // Rate limit: 3 requests per second max for DexScreener (approx 300ms wait)
        await new Promise(r => setTimeout(r, 300));
    }
    if (tokensToBuy.length === 0) {
        console.log('No matching tokens found.');
        return;
    }
    // 3. Buy Strategy
    console.log(`\nAttempting to buy ${tokensToBuy.length} tokens...`);
    for (const token of tokensToBuy) {
        console.log(`Buying 0.0001 ETH of ${token.symbol} (${token.repo})...`);
        // Attempt the swap via Vincent Wallet
        await wallet.swap(token.address, 0.0001); // excessive caution: very small test amount
        // Wait to facilitate RPC/Wallet rate limits
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log('Run complete.');
}
// Execute
main().catch(console.error);
