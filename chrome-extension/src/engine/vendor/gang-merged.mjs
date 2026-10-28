// Official gangfun/gang-launchpad @ 7d6dfd318d6a15c65563c3d1b0e099ef57bdf123.
// Mainnet deployment: docs/MAINNET-GANG-2026-10-27.md. Curve kind=1 only;
// kind=2 is fair mint and must never be priced as a bonding curve.
import { parseAbi } from 'viem';
import { V2_ABI } from './gang-abi.mjs';

export const GANG_MERGED_PAD = '0x15CFD2dc8278Fb87a1783ef42111618E20874365';
export const GANG_ROUTER = '0xE040445690Aa56C8b68B7f7038C7b2562B5079C4';
export const GANG_MERGED_ABI = parseAbi([
  'function kindOf(address token) view returns (uint8)',
  'function curves(address token) view returns (address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,uint16 buyTaxBps,uint16 sellTaxBps,uint16 dividendBps,address pair,address refPair)',
  'function buy(address token,uint256 quoteIn,uint256 minTokensOut) returns (uint256)',
  'function sell(address token,uint256 tokensIn,uint256 minQuoteOut) returns (uint256)',
  'function isAgent(address account) view returns (bool)',
  'function walletRoom(address token,address buyer) view returns (uint256)',
  'function agentGateEnabled() view returns (bool)',
  'function routers(address router) view returns (bool)',
  'function wbnb() view returns (address)',
  'function PROTOCOL_FEE_BPS() view returns (uint256)',
  'function VIRTUAL_TOKEN() view returns (uint256)',
  'event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 protocolFee,uint256 tax,uint256 tokensOut,uint256 realQuote)',
  'event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 protocolFee,uint256 tax,uint256 quoteOut,uint256 realQuote)',
]);
export const GANG_ROUTER_ABI = parseAbi([
  'function pad() view returns (address)',
  'function wbnb() view returns (address)',
  'function v3BuyBNB(address token,uint256 minTokensOut,uint256 deadline) payable returns (uint256 tokensOut)',
]);
export const GANG_TOKEN_BINDING = parseAbi(['function launchpad() view returns (address)']);
export const GANG_S_ABI = V2_ABI.filter(entry => entry.name !== 'curves' && entry.name !== 'Created').concat(parseAbi([
  'function curves(address token) view returns (address creator,address quote,uint128 realQuote,uint128 sold,uint128 gradAmt,uint128 virtualQuote,bool graduated,address pair,address refPair)',
  'function DIVIDEND_TAX_BPS() view returns (uint256)',
  'function PLATFORM_TAX_BPS() view returns (uint256)',
  'event Created(address indexed token,address indexed creator,string name,string symbol,address indexed quote,uint256 gradAmt)',
]));
