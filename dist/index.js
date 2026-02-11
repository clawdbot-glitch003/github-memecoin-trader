"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
require("dotenv/config");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ----------------------
// Trade Logger (Local DB)
// ----------------------
class TradeLogger {
    logPath;
    constructor() {
        this.logPath = path.join(process.cwd(), 'trades.jsonl');
    }
    log(record) {
        const line = JSON.stringify(record) + '\n';
        try {
            fs.appendFileSync(this.logPath, line, 'utf8');
            console.log(`[DB] Trade logged: ${record.symbol} (${record.status})`);
        }
        catch (e) {
            console.error('[DB] Failed to log trade:', e.message);
        }
    }
}
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
            // Return empty or throw based on preference. 
            // Returning empty string to allow dry-run to proceed if API key is partial?
            return '';
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
        // Check if DRY_RUN is enabled
        if (process.env.DRY_RUN === 'true') {
            console.log(`[DRY RUN] Would swap ${amountInEth} ETH for ${tokenAddress}`);
            return { status: 'simulated', txHash: '0x_simulated_hash' };
        }
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
// Clanker Scanner
// ----------------------
class ClankerScanner {
    baseUrl = 'https://www.clanker.world/api/tokens';
    // Search specifically for a token by name/symbol using Clanker API
    async searchToken(query) {
        try {
            const resp = await axios_1.default.get(this.baseUrl, {
                params: {
                    search: query,
                    q: query, // Fallback common param
                    chainId: 8453,
                    sort: 'desc', // Newest first
                    limit: 5
                },
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            let tokenList = [];
            if (Array.isArray(resp.data)) {
                tokenList = resp.data;
            }
            else if (resp.data && Array.isArray(resp.data.data)) {
                tokenList = resp.data.data;
            }
            return tokenList;
        }
        catch (e) {
            return [];
        }
    }
}
// ----------------------
// Telegram Notifier
// ----------------------
class TelegramNotifier {
    botToken;
    chatId;
    constructor() {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
        this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    }
    async sendMessage(text) {
        if (process.env.ENABLE_TELEGRAM !== 'true')
            return;
        if (!this.botToken || !this.chatId) {
            console.log('[Telegram] No credentials, skipping message:', text);
            return;
        }
        try {
            const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
            await axios_1.default.post(url, {
                chat_id: this.chatId,
                text: text,
                parse_mode: 'Markdown'
            });
        }
        catch (e) {
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
    const isDryRun = process.env.DRY_RUN === 'true';
    console.log(`Starting Memecoin Trader (Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'})...`);
    if (process.env.ENABLE_TELEGRAM === 'true') {
        await telegram.sendMessage(`🚀 *Memecoin Trader Started*\nMode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`);
    }
    // 1. Get Wallet Info
    try {
        const address = await wallet.getAddress();
        console.log(`Wallet Address: ${address || 'Unknown'}`);
    }
    catch (error) {
        console.error('Failed to initialize wallet. Check your API key.');
        process.exit(1);
    }
    // 2. Scan GitHub for Trending Repos
    console.log('Scanning trending GitHub repos...');
    const repos = await githubScanner.getTrendingRepos();
    console.log(`Found ${repos.length} potential GitHub repos.`);
    const tokensToBuy = [];
    for (const repo of repos) {
        // Clean repo name: "Code-Pilot" -> "Code Pilot", "React2Shell" -> "React2Shell"
        // Also split camelCase: "codePilot" -> "code Pilot"
        const cleanName = repo.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' ').toLowerCase();
        console.log(`Checking Clanker for repo: ${repo.name} (query: "${cleanName}")...`);
        // Search Clanker for tokens matching the cleaned repo name
        const matchingTokens = await clankerScanner.searchToken(cleanName);
        if (matchingTokens.length > 0) {
            // Pick the best match (first one, assuming sort=desc gives newest/best match)
            const bestMatch = matchingTokens[0];
            // Calculate Age
            const createdAt = new Date(bestMatch.created_at).getTime();
            const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);
            // Filter: Freshness (< 7 days)
            if (ageHours > 7 * 24) {
                console.log(`  Skipping ${bestMatch.symbol}: Too old (${(ageHours / 24).toFixed(1)} days)`);
                continue;
            }
            // Deduplication check: Don't buy same token twice in one run
            if (tokensToBuy.some(t => t.address === bestMatch.contract_address)) {
                continue;
            }
            console.log(`  Found matching Clanker token for ${repo.name}: ${bestMatch.symbol} (${bestMatch.contract_address})`);
            console.log(`  Age: ${(ageHours / 24).toFixed(1)} days`);
            const tokenInfo = {
                address: bestMatch.contract_address,
                symbol: bestMatch.symbol,
                repo: repo.name,
                source: 'clanker'
            };
            await telegram.sendMessage(`🔍 *GitHub x Clanker Opportunity*\n` +
                `Repo: [${repo.name}](${repo.html_url})\n` +
                `Token: ${tokenInfo.symbol}\n` +
                `Age: ${(ageHours / 24).toFixed(1)} days\n` +
                `Address: \`${tokenInfo.address}\``);
            tokensToBuy.push(tokenInfo);
        }
        // Rate limit: 1000ms to be kind to Clanker API during search
        await new Promise(r => setTimeout(r, 1000));
    }
    if (tokensToBuy.length === 0) {
        console.log('No matching tokens found.');
        return;
    }
    // 3. Buy Strategy
    console.log(`\nAttempting to buy ${tokensToBuy.length} tokens...`);
    for (const token of tokensToBuy) {
        console.log(`Buying 0.0001 ETH of ${token.symbol} (${token.source})...`);
        // Attempt the swap via Vincent Wallet
        const result = await wallet.swap(token.address, 0.0001); // excessive caution: very small test amount
        if (result) {
            const status = isDryRun ? 'simulated' : 'executed';
            // Log to DB
            logger.log({
                timestamp: new Date().toISOString(),
                symbol: token.symbol,
                address: token.address,
                source: token.source,
                action: 'buy',
                amount_eth: 0.0001,
                status: status,
                tx_hash: result.txHash,
                repo: token.repo
            });
            await telegram.sendMessage(`💸 *Buy Executed (${isDryRun ? 'SIMULATED' : 'LIVE'})*\n` +
                `Token: ${token.symbol}\n` +
                `Source: ${token.source}\n` +
                `Amount: 0.0001 ETH\n` +
                `Status: ${isDryRun ? 'Simulated' : 'Submitted'}`);
        }
        else {
            // Log failure
            logger.log({
                timestamp: new Date().toISOString(),
                symbol: token.symbol,
                address: token.address,
                source: token.source,
                action: 'buy',
                amount_eth: 0.0001,
                status: 'failed',
                repo: token.repo
            });
        }
        // Wait to facilitate RPC/Wallet rate limits
        await new Promise(r => setTimeout(r, 2000));
    }
    console.log('Run complete.');
}
// Execute
main().catch(console.error);
