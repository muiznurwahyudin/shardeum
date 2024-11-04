import { AccountMap, AccountType, BaseAccount, InternalTx, InternalTxBase, InternalTXType, ReadableReceipt, TransferFromSecureAccount, WrappedAccount, WrappedEVMAccount, WrappedStates } from './shardeumTypes'
import { updateEthAccountHash } from './wrappedEVMAccountFunctions'
import { ShardeumFlags } from './shardeumFlags'
import { generateTxId } from '../utils'
import { toShardusAddress } from './evmAddress'

import { ShardusTypes, DevSecurityLevel, Shardus } from '@shardus/core'
import { verifyMultiSigs } from '../setup/helpers'
import { shardusConfig } from '..'
import { _shardusWrappedAccount } from './wrappedEVMAccountFunctions'
import { crypto } from '../setup/helpers'
import { VectorBufferStream } from '@shardus/core'
import { TypeIdentifierEnum } from '../types/enum/TypeIdentifierEnum'

import genesisSecureAccounts from '../config/genesis-secure-accounts.json'
validateSecureAccountConfig(genesisSecureAccounts)

export interface SecureAccount extends BaseAccount {
  id: string
  hash: string
  timestamp: number
  name: string
  nextTransferAmount: bigint
  nextTransferTime: number
  nonce: number
}

export interface SecureAccountConfig {
  Name: string;
  SourceFundsAddress: string;
  RecipientFundsAddress: string;
  SecureAccountAddress: string; // This will be the 32-byte address format
  SourceFundsBalance: string;
}

export function isSecureAccount(obj: unknown): obj is SecureAccount {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    'nextTransferAmount' in obj &&
    'nextTransferTime' in obj
  )
}

type SerializedSecureAccount = Omit<SecureAccount, 'nextTransferAmount'> & {
  nextTransferAmount: string;
}

export function initializeSecureAccount(
  secureAccountConfig: SecureAccountConfig,
  latestCycles: { start: number }[]
): SecureAccount {
  let cycleStart = 0
  if (latestCycles.length > 0) {
    cycleStart = latestCycles[0].start * 1000
  }

  const secureAccount: SecureAccount = {
    id: secureAccountConfig.SecureAccountAddress, // Use SecureAccountAddress as id
    hash: '',
    timestamp: cycleStart,
    accountType: AccountType.SecureAccount,
    name: secureAccountConfig.Name,
    nextTransferAmount: BigInt(0),
    nextTransferTime: 0,
    nonce: 0
  }

  updateEthAccountHash(secureAccount)

  if (ShardeumFlags.VerboseLogs) console.log('SecureAccount created', secureAccount)

  return secureAccount
}

interface SecureAccountData {
  Name: string
  SourceFundsAddress: string
  RecipientFundsAddress: string
  SecureAccountAddress: string
}

export const secureAccountDataMap: Map<string, SecureAccountData> = new Map(
  genesisSecureAccounts.map(account => [account.Name, account])
)

interface CrackedData {
  sourceKeys: string[]
  targetKeys: string[]
}

export function crack(tx: TransferFromSecureAccount): CrackedData {
  if (!secureAccountDataMap.has(tx.accountName)) {
    console.log('Secure account not found for transfer from secure account!', JSON.stringify(tx, null, 2));
    throw new Error(`Secure account ${tx.accountName} not found`);
  }
  return {
    sourceKeys: [
      toShardusAddress(secureAccountDataMap.get(tx.accountName).SourceFundsAddress, AccountType.Account),
      toShardusAddress(secureAccountDataMap.get(tx.accountName).SecureAccountAddress, AccountType.SecureAccount),
    ],
    targetKeys: [
      toShardusAddress(secureAccountDataMap.get(tx.accountName).RecipientFundsAddress, AccountType.Account)
    ]
  }
}

export function validateTransferFromSecureAccount(tx: TransferFromSecureAccount, shardus: Shardus): { success: boolean; reason: string } {
  if (tx.txType !== InternalTXType.TransferFromSecureAccount) {
    console.log('Invalid transaction type for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Invalid transaction type' }
  }

  if (typeof tx.amount !== 'string' || !/^\d+$/.test(tx.amount)) {
    console.log('Invalid amount format for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Invalid amount format' }
  }

  if (BigInt(tx.amount) <= 0) {
    console.log('Amount is negative or zero for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Amount is negative or zero' }
  }

  if (typeof tx.accountName !== 'string' || tx.accountName.trim() === '') {
    console.log('Invalid account name for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Invalid account name' }
  }

  if (typeof tx.nonce !== 'number' || tx.nonce < 0) {
    console.log('Invalid nonce for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Invalid nonce' }
  }

  const secureAccountData = secureAccountDataMap.get(tx.accountName)
  if (!secureAccountData) {
    console.log('Secure account not found for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Secure account not found' }
  }

  // Verify signatures
  if (!tx.sign || tx.sign.length === 0) {
    console.log('Missing signatures for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Missing signatures' }
  }

  const txData = {
    txType: tx.txType,
    amount: tx.amount,
    accountName: tx.accountName,
    nonce: tx.nonce
  }

  const allowedPublicKeys = shardus.getMultisigPublicKeys()
  const requiredSigs = Math.max(1, shardusConfig.debug.minMultiSigRequiredForGlobalTxs || 1)

  const isSignatureValid = verifyMultiSigs(
    txData,
    tx.sign,
    allowedPublicKeys,
    requiredSigs,
    DevSecurityLevel.High
  )

  if (!isSignatureValid) {
    console.log('Found invalid signatures for transfer from secure account!', {
      requiredSigs,
      allowedPublicKeys,
      txSign: tx.sign,
      txData,
      secureAccountData
    });
    return { success: false, reason: 'Invalid signatures' }
  }

  return { success: true, reason: '' }
}

export function verify(
  tx: TransferFromSecureAccount,
  wrappedStates: WrappedStates,
  shardus: Shardus
): { success: boolean; reason: string } {
  const commonValidation = validateTransferFromSecureAccount(tx, shardus)
  if (!commonValidation.success) {
    console.log('Common validation failed for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: commonValidation.reason }
  }

  const secureAccountConfig = secureAccountDataMap.get(tx.accountName)
  // this may be wrong, and its possible that I need to make wrappedStates give me this account as a wrapped evm account?
  // not sure but this is probably fine
  const secureAccount = wrappedStates[secureAccountConfig.SecureAccountAddress] as WrappedAccount

  if (!secureAccount || secureAccount.data.accountType !== AccountType.SecureAccount) {
    console.log('Secure account not found or invalid for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Secure account not found or invalid' }
  }

  const sourceFundsAccount = wrappedStates[secureAccountConfig.SourceFundsAddress] as WrappedAccount
  const recipientFundsAccount = wrappedStates[secureAccountConfig.RecipientFundsAddress] as WrappedAccount

  if (!sourceFundsAccount || !recipientFundsAccount) {
    console.log('Source or recipient account not found for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Source or recipient account not found' }
  }

  const transferAmount = BigInt(tx.amount)
  const sourceBalance = BigInt(sourceFundsAccount.data.account.balance)

  if (sourceBalance < transferAmount) {
    console.log('Insufficient balance in source account for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Insufficient balance in source account' }
  }

  // assert that the nonce is the next consecutive number
  if (tx.nonce !== Number(secureAccount.data.nonce) + 1) {
    console.log('Invalid nonce for transfer from secure account!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Invalid nonce' }
  }

  const currentTime = Date.now()
  if (currentTime < secureAccount.data.nextTransferTime) {
    console.log('Transfer not allowed yet, time restriction!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Transfer not allowed yet, time restriction' }
  }

  if (transferAmount > secureAccount.data.nextTransferAmount) {
    console.log('Transfer amount exceeds allowed limit!', JSON.stringify(tx, null, 2));
    return { success: false, reason: 'Transfer amount exceeds allowed limit' }
  }

  return { success: true, reason: 'Valid transaction' }
}

export async function apply(
  tx: TransferFromSecureAccount,
  txId: string,
  txTimestamp: number,
  wrappedStates: WrappedStates,
  shardus: Shardus,
  applyResponse: ShardusTypes.ApplyResponse
): Promise<void> {
  const secureAccountConfig = secureAccountDataMap.get(tx.accountName)
  // throw if the secure account config is not found
  if (!secureAccountConfig) {
    console.log('Secure account config not found for transfer from secure account!', JSON.stringify(tx, null, 2));
    throw new Error('Secure account config not found');
  }
  
  const sourceEOA = wrappedStates[secureAccountConfig.SourceFundsAddress];
  const destEOA = wrappedStates[secureAccountConfig.RecipientFundsAddress];
  const secureAccount = wrappedStates[secureAccountConfig.SecureAccountAddress];

  // throw if any of the required accounts are not found
  if (!sourceEOA || !destEOA || !secureAccount) {
    console.log('One or more required accounts not found for transfer from secure account!', JSON.stringify(tx, null, 2));
    throw new Error('One or more required accounts not found');
  }

  const sourceEOAData = sourceEOA.data as WrappedEVMAccount;
  const destEOAData = destEOA.data as WrappedEVMAccount;
  const secureAccountData = secureAccount.data as SecureAccount;

  if (!sourceEOA || !destEOA || !secureAccount) {
    console.log('One or more required accounts not found for transfer from secure account!', JSON.stringify(tx, null, 2));
    throw new Error('One or more required accounts not found');
  }

  const amount = BigInt(tx.amount);

  if (BigInt(sourceEOAData.account.balance) < amount) {
    console.log('Insufficient balance in source account for transfer from secure account!', JSON.stringify(tx, null, 2));
    throw new Error('Insufficient balance in source account');
  }

  // assert that the result of the balance subtraction has not overflowed or underflowed
  if (BigInt(sourceEOAData.account.balance) - amount < 0) {
    console.log('Balance subtraction overflowed for source account for transfer from secure account!', JSON.stringify(tx, null, 2));
    throw new Error('Balance subtraction overflowed');
  }

  sourceEOAData.balance = Number(BigInt(sourceEOAData.account.balance) - amount)
  destEOAData.balance = Number(BigInt(destEOAData.account.balance) + amount)

  // update timestamp for each account
  sourceEOAData.timestamp = txTimestamp;
  destEOAData.timestamp = txTimestamp;
  secureAccountData.timestamp = txTimestamp;

  secureAccountData.nonce = tx.nonce;
  
  // consolelog the hashes before and after
  const hashesBefore = {
    sourceEOA: sourceEOAData.hash,
    destEOA: destEOAData.hash,
    secureAccount: secureAccountData.hash
  };
  updateEthAccountHash(sourceEOAData);
  updateEthAccountHash(destEOAData);
  updateEthAccountHash(secureAccountData);
  const hashesAfter = {
    sourceEOA: sourceEOAData.hash,
    destEOA: destEOAData.hash,
    secureAccount: secureAccountData.hash
  };

  const wrappedSourceEOA = _shardusWrappedAccount(sourceEOAData);
  const wrappedDestEOA = _shardusWrappedAccount(destEOAData);
  const wrappedSecureAccount = _shardusWrappedAccount(secureAccountData);
  const wrappedHashes = {
    sourceEOA: (wrappedSourceEOA.data as any).hash,
    destEOA: (wrappedDestEOA.data as any).hash,
    secureAccount: (wrappedSecureAccount.data as any).hash
  };
 
  // one nice clean log statement for the hashes, including the before and after
  console.log('Hashes:', {
    before: hashesBefore,
    after: hashesAfter,
    wrappedHashes: wrappedHashes
  });

  try {
    shardus.applyResponseAddChangedAccount(
      applyResponse,
    secureAccountConfig.SourceFundsAddress,
    wrappedSourceEOA as ShardusTypes.WrappedResponse,
    txId,
    applyResponse.txTimestamp
  );
  shardus.applyResponseAddChangedAccount(
    applyResponse,
    secureAccountConfig.RecipientFundsAddress,
    wrappedDestEOA as ShardusTypes.WrappedResponse,
    txId,
    applyResponse.txTimestamp
  );
  shardus.applyResponseAddChangedAccount(
    applyResponse,
    secureAccountConfig.SecureAccountAddress,
    wrappedSecureAccount as ShardusTypes.WrappedResponse,
    txId,
      applyResponse.txTimestamp
    );
  } catch (e) {
    console.log('Error adding changed account for transfer from secure account!', JSON.stringify(tx, null, 2));
    throw e;
  }
  console.log('Successfully added changed accounts for transfer from secure account!');


  // Create the receipt data
  const readableReceipt: ReadableReceipt = {
    status: 1, 
    transactionHash: txId,
    transactionIndex: '0x0',
    blockHash: '', 
    blockNumber: '0x0',
    from: secureAccountConfig.SourceFundsAddress,
    to: secureAccountConfig.RecipientFundsAddress,
    contractAddress: null,
    cumulativeGasUsed: '0x0',
    gasUsed: '0x0',
    logs: [],
    logsBloom: '0x',
    type: '0x0',
    // Additional fields for TransferFromSecureAccount
    value: tx.amount,
    nonce: `0x${tx.nonce.toString(16)}`, 
    gasRefund: '0x0',
    data: '', 
  };

  const wrappedReceiptAccount: WrappedEVMAccount = {
    timestamp: applyResponse.txTimestamp,
    ethAddress: txId, // Using txId as ethAddress for the receipt
    hash: '',
    readableReceipt,
    amountSpent: '0x0',
    txId: txId,
    accountType: AccountType.SecureAccount,
    txFrom: secureAccountConfig.SourceFundsAddress,
    
  };

  console.log('Getting receiptShardusAccount from wrappedReceiptAccount:', JSON.stringify(wrappedReceiptAccount, null, 2));
  const receiptShardusAccount = _shardusWrappedAccount(wrappedReceiptAccount);
  
  console.log('SENDING RECEIPT TO ARCHIVER', JSON.stringify(receiptShardusAccount, null, 2));
  try {
    shardus.applyResponseAddReceiptData(
      applyResponse,
      receiptShardusAccount,
      crypto.hashObj(receiptShardusAccount)
    );
    console.log('Successfully added receipt data for transfer from secure account!');
  } catch (e) {
    console.log('Error adding receipt data for transfer from secure account!', JSON.stringify(tx, null, 2));
    throw e;
  }
}

export function isTransferFromSecureAccount(tx: InternalTxBase): tx is TransferFromSecureAccount {
  return tx.internalTXType === InternalTXType.TransferFromSecureAccount
}

function validateSecureAccountConfig(config: SecureAccountConfig[]): void {
  const seenAddresses = new Set<string>()
  
  for (const account of config) {
    if (account.SourceFundsAddress === account.RecipientFundsAddress) {
      throw new Error(`Invalid secure account config for ${account.Name}: Source and recipient addresses must be different`)
    }
    
    if (seenAddresses.has(account.SourceFundsAddress)) {
      throw new Error(`Duplicate source address found: ${account.SourceFundsAddress}`)
    }
    if (seenAddresses.has(account.RecipientFundsAddress)) {
      throw new Error(`Duplicate recipient address found: ${account.RecipientFundsAddress}`)
    }
    
    seenAddresses.add(account.SourceFundsAddress)
    seenAddresses.add(account.RecipientFundsAddress)
  }
}