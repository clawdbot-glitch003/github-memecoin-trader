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
const ethers_1 = require("ethers");
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
            console.log(`[DB] Trade logged: ${record.symbol} (${record.action})`);
        }
        catch (e) {
            console.error('[DB] Failed to log trade:', e.message);
        }
    }
}
// ----------------------
// Portfolio Manager (Paper Trading)
// ----------------------
class PortfolioManager {
    dbPath;
    state;
    constructor() {
        this.dbPath = path.join(process.cwd(), 'portfolio.json');
        this.state = this.load();
    }
    load() {
        if (fs.existsSync(this.dbPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
            }
            catch (e) {
                console.error('Failed to load portfolio, starting fresh.');
            }
        }
        // Default starting state: 1 ETH, no positions
        return { cash_eth: 1.0, positions: {} };
    }
    save() {
        fs.writeFileSync(this.dbPath, JSON.stringify(this.state, null, 2));
    }
    getBalance() {
        return this.state.cash_eth;
    }
    canAfford(amountEth) {
        return this.state.cash_eth >= amountEth;
    }
    recordBuy(symbol, address, amountEth, amountToken, priceEth, poolAddress) {
        this.state.cash_eth -= amountEth;
        // Track position by address (unique key)
        if (!this.state.positions[address]) {
            this.state.positions[address] = { symbol, amount: 0, entry_price_eth: 0 };
        }
        const pos = this.state.positions[address];
        // Store pool address if available and not set
        if (poolAddress && !pos.pool_address) {
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
    recordSell(address, amountToken, executionPriceEth) {
        const pos = this.state.positions[address];
        if (!pos)
            return;
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
    getPositions() {
        return Object.entries(this.state.positions).map(([k, v]) => ({ address: k, ...v }));
    }
}
// ----------------------
// RPC Price Fetcher (Alchemy)
// ----------------------
class RpcPriceFetcher {
    provider = null;
    constructor() {
        const apiKey = process.env.ALCHEMY_API_KEY;
        if (apiKey) {
            const url = `https://base-mainnet.g.alchemy.com/v2/${apiKey}`;
            this.provider = new ethers_1.ethers.JsonRpcProvider(url);
        }
        else if (process.env.BASE_RPC_URL) {
            this.provider = new ethers_1.ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
        }
        else {
            // console.warn('No Alchemy API Key or Base RPC URL provided. Price fetching will fail.');
        }
    }
    isReady() {
        return this.provider !== null;
    }
    // Returns Price of Token in ETH
    async getPrice(poolAddress, tokenAddress) {
        if (!this.provider)
            return null;
        try {
            const poolContract = new ethers_1.ethers.Contract(poolAddress, [
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
        }
        catch (e) {
            console.error(`[RPC] Price fetch failed for pool ${poolAddress}:`, e.message);
            return null;
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
    async getQuote(tokenAddress, amountInEth) {
        try {
            const sellToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
            const body = {
                sellToken,
                buyToken: tokenAddress,
                sellAmount: BigInt(Math.floor(amountInEth * 1e18)).toString(),
                chainId: this.chainId,
                slippageBps: 100 // 1%
            };
            const resp = await axios_1.default.post(`${this.baseUrl}/api/skills/evm-wallet/swap/preview`, body, { headers: this.getHeaders() });
            const amountOut = parseFloat(resp.data.buyAmount) / 1e18;
            const price = amountInEth / amountOut; // Price in ETH per Token
            return { buyAmount: amountOut, price };
        }
        catch (e) {
            // console.error(`[Wallet] Quote failed for ${tokenAddress}:`, e.message);
            return null;
        }
    }
    async getSellQuote(tokenAddress, tokenAmount) {
        try {
            const sellToken = tokenAddress;
            const buyToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // ETH
            const body = {
                sellToken,
                buyToken,
                sellAmount: tokenAmount, // exact token amount in WEI string
                chainId: this.chainId,
                slippageBps: 200 // 2% 
            };
            const resp = await axios_1.default.post(`${this.baseUrl}/api/skills/evm-wallet/swap/preview`, body, { headers: this.getHeaders() });
            // Output is ETH (18 decimals)
            const ethAmount = parseFloat(resp.data.buyAmount) / 1e18;
            const amountIn = parseFloat(tokenAmount) / 1e18;
            const price = ethAmount / amountIn; // Price of 1 Token in ETH
            return { ethAmount, price };
        }
        catch (e) {
            return null;
        }
    }
    async swap(tokenAddress, amountInEth) {
        const sellToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
        // Check if DRY_RUN is enabled
        if (process.env.DRY_RUN === 'true') {
            try {
                console.log(`[DRY RUN] Getting quote for ${amountInEth} ETH -> ${tokenAddress}...`);
                const quote = await this.getQuote(tokenAddress, amountInEth);
                if (!quote)
                    throw new Error('Failed to get quote');
                console.log(`[DRY RUN] Quote: ${quote.buyAmount.toFixed(2)} tokens @ ${quote.price.toFixed(9)} ETH`);
                return { status: 'simulated', txHash: '0x_simulated_hash', buyAmount: quote.buyAmount, price: quote.price };
            }
            catch (e) {
                console.error(`[DRY RUN] Quote failed:`, e.message);
                return { status: 'simulated', txHash: '0x_simulated_hash', buyAmount: 0, price: 0 };
            }
        }
        try {
            console.log(`Attempting to swap ${amountInEth} ETH for ${tokenAddress}...`);
            const body = {
                sellToken,
                buyToken: tokenAddress,
                sellAmount: BigInt(Math.floor(amountInEth * 1e18)).toString(),
                chainId: this.chainId,
                slippageBps: 200 // 2% slippage
            };
            const resp = await axios_1.default.post(`${this.baseUrl}/api/skills/evm-wallet/swap/execute`, body, { headers: this.getHeaders() });
            console.log('Swap executed!', resp.data);
            return resp.data;
        }
        catch (e) {
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
    async searchToken(query) {
        try {
            const resp = await axios_1.default.get(this.baseUrl, {
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
                        let action = null;
                        if (pnlPercent >= 50)
                            action = 'sell_tp';
                        if (pnlPercent <= -20)
                            action = 'sell_sl';
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
                            await telegram.sendMessage(`📉 *${action === 'sell_tp' ? 'Take Profit' : 'Stop Loss'} Executed*\n` +
                                `Token: ${pos.symbol}\n` +
                                `PnL: ${pnlPercent.toFixed(2)}%\n` +
                                `Price: ${currentPrice.toFixed(9)} ETH\n` +
                                `Proceeds: ${((ethAmount || 0)).toFixed(4)} ETH`);
                        }
                    }
                    // Rate check
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        catch (e) {
            console.error('Portfolio update failed:', e);
        }
        // 1. Scan GitHub for NEW Opportunities
        if (!portfolio.canAfford(0.0001)) {
            console.log('Skipping GitHub scan: Not enough ETH for new buys (min 0.0001).');
        }
        else {
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
                        console.log(`  Skipping ${bestMatch.symbol}: Too old (${(ageHours / 24).toFixed(1)} days)`);
                        continue;
                    }
                    // Deduplication check (Portfolio)
                    const existingPos = portfolio.getPositions().find(p => p.address === bestMatch.contract_address);
                    if (existingPos) {
                        console.log(`  Skipping ${bestMatch.symbol}: Already holding position.`);
                        continue;
                    }
                    console.log(`  Found Opportunity: ${bestMatch.symbol} (${bestMatch.contract_address}). Age: ${(ageHours / 24).toFixed(1)} days.`);
                    // Buy
                    const buyAmt = 0.0001;
                    console.log(`Buying ${buyAmt} ETH of ${bestMatch.symbol}...`);
                    const result = await wallet.swap(bestMatch.contract_address, buyAmt);
                    if (result) {
                        const status = isDryRun ? 'simulated' : 'executed';
                        let buyAmount = result.buyAmount || 0;
                        let priceEth = result.price || 0;
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
                        }
                        else {
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
                        await telegram.sendMessage(`💸 *Buy Executed (${isDryRun ? 'SIMULATED' : 'LIVE'})*\n` +
                            `Token: ${bestMatch.symbol}\n` +
                            `Repo: ${repo.name}\n` +
                            `Entry: ${priceEth.toFixed(9)} ETH`);
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
