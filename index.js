require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

/**
 * Vincent API Client
 */
class VincentWallet {
    constructor() {
        this.apiKey = process.env.API_KEY;
        this.baseUrl = process.env.BASE_URL;
        this.chainId = process.env.CHAIN_ID;
    }

    async getHeaders() {
        return {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    async getAddress() {
        try {
            const resp = await axios.get(`${this.baseUrl}/api/skills/evm-wallet/address`, {
                headers: await this.getHeaders()
            });
            return resp.data.address;
        } catch (e) {
            console.error('Error getting address:', e.message);
            throw e;
        }
    }

    async getBalances() {
        try {
            const resp = await axios.get(`${this.baseUrl}/api/skills/evm-wallet/balances`, {
                headers: await this.getHeaders(),
                params: { chainIds: this.chainId }
            });
            return resp.data;
        } catch (e) {
            console.error('Error getting balances:', e.message);
            throw e;
        }
    }

    async swap(tokenAddress, amountInEth) {
        // First convert ETH to target token
        // Use 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for ETH
        const sellToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
        
        try {
            console.log(`Attempting to swap ${amountInEth} ETH for ${tokenAddress}...`);
            const body = {
                sellToken,
                buyToken: tokenAddress,
                sellAmount: amountInEth.toString(),
                chainId: parseInt(this.chainId),
                slippageBps: 200 // 2% slippage for memecoins
            };

            const resp = await axios.post(`${this.baseUrl}/api/skills/evm-wallet/swap/execute`, body, {
                headers: await this.getHeaders()
            });

            console.log('Swap executed!', resp.data);
            return resp.data;
        } catch (e) {
            console.error('Swap failed:', e.response?.data || e.message);
            // Don't throw, just return null so the loop continues
            return null;
        }
    }
}

/**
 * GitHub Trend Scanner
 */
class GitHubScanner {
    constructor() {
        this.token = process.env.GITHUB_TOKEN;
    }

    async getTrendingRepos() {
        // Search for repos created in last 7 days, sorted by stars
        const date = new Date();
        date.setDate(date.getDate() - 7);
        const dateStr = date.toISOString().split('T')[0];
        
        const q = `created:>${dateStr} sort:stars`;
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&order=desc`;
        
        try {
            const headers = { 'User-Agent': 'Memecoin-Trader-Bot' };
            if (this.token) headers['Authorization'] = `token ${this.token}`;

            const resp = await axios.get(url, { headers });
            return resp.data.items || [];
        } catch (e) {
            console.error('GitHub API error:', e.message);
            return [];
        }
    }

    // Heuristic: Check if repo mentions a contract address or token symbol
    extractTokenInfo(repo) {
        // Very basic regex for EVM addresses
        const addressRegex = /0x[a-fA-F0-9]{40}/g;
        
        const text = (repo.description || '') + ' ' + (repo.name || '');
        const addresses = text.match(addressRegex);

        if (addresses && addresses.length > 0) {
            // Assume the first address found is the token
            // TODO: Validate if it's actually a token contract
            return {
                address: addresses[0],
                name: repo.name,
                stars: repo.stargazers_count,
                url: repo.html_url
            };
        }
        return null;
    }
}

class MarketScanner {
    constructor() {
        this.baseUrl = 'https://api.dexscreener.com/latest/dex';
    }

    async searchToken(query) {
        try {
            const url = `${this.baseUrl}/search?q=${encodeURIComponent(query)}`;
            const resp = await axios.get(url);
            
            if (!resp.data || !resp.data.pairs) return [];
            
            // Filter for Base chain
            return resp.data.pairs.filter(p => p.chainId === 'base');
        } catch (e) {
            console.error(`DexScreener API error for ${query}:`, e.message);
            return [];
        }
    }
}

/**
 * Main Logic
 */
async function main() {
    const wallet = new VincentWallet();
    const githubScanner = new GitHubScanner();
    const marketScanner = new MarketScanner();

    console.log('Starting Memecoin Trader...');
    
    // 1. Get Wallet Info
    const address = await wallet.getAddress();
    console.log(`Wallet Address: ${address}`);

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
            // Found tokens! Let's pick the best pair based on liquidity
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
        
        // Rate limit: 5 requests per second max for DexScreener
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
        await wallet.swap(token.address, 0.0001); // Test amount
        
        // Wait to avoid wallet/RPC rate limits
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('Run complete.');
}

if (require.main === module) {
    main().catch(console.error);
}
