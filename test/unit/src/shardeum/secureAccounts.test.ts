import { initializeSecureAccount, isSecureAccount, SecureAccount, SecureAccountConfig, validateTransferFromSecureAccount, verify, apply } from '../../../../src/shardeum/secureAccounts'
import { ShardeumFlags } from '../../../../src/shardeum/shardeumFlags'
import * as WrappedEVMAccountFunctions from '../../../../src/shardeum/wrappedEVMAccountFunctions'
import { AccountMap, AccountType, InternalTx, InternalTXType, WrappedStates } from '../../../../src/shardeum/shardeumTypes'
import { Shardus } from '@shardus/core'
import { shardusConfig } from '../../../../src'
import { VectorBufferStream } from '@shardus/core'
import { TypeIdentifierEnum } from '../../../../src/types/enum/TypeIdentifierEnum'
import { serializeSecureAccount, deserializeSecureAccount } from '../../../../src/types/SecureAccount'
import { ApplyResponse } from '@shardus/core/dist/state-manager/state-manager-types'
import { DevSecurityLevel, StrictShardusConfiguration } from '@shardus/core/dist/shardus/shardus-types'
import * as ethers from 'ethers'
import { Utils } from '@shardus/types'

jest.mock('../../../../src/shardeum/wrappedEVMAccountFunctions', () => ({
  updateEthAccountHash: jest.fn(),
  _shardusWrappedAccount: (wrappedEVMAccount) => ({
    accountId: wrappedEVMAccount.ethAddress || 'mock-account-id',
    stateId: wrappedEVMAccount.hash || 'mock-state-id',
    data: wrappedEVMAccount,
    timestamp: wrappedEVMAccount.timestamp || Date.now()
  })
}));

jest.mock('@shardus/core', () => {
  const actual = jest.requireActual('@shardus/core')
  return {
    Shardus: jest.fn().mockImplementation(() => ({
      getMultisigPublicKeys: jest.fn().mockReturnValue({
        '0x123': 2
      }),
      applyResponseAddChangedAccount: jest.fn(),
      applyResponseAddReceiptData: jest.fn()
    })),
    VectorBufferStream: actual.VectorBufferStream,
    DevSecurityLevel: {
      High: 2,
      Medium: 1,
      Low: 0
    }
  }
})

// Add mock config with required properties
const mockShardusConfig = {
  ...shardusConfig,
  heartbeatInterval: 1000,
  baseDir: '/tmp',
  transactionExpireTime: 3600,
  port: 9001,
  host: 'localhost',
  server: {},
  logs: { level: 'info' },
  storage: { type: 'memory' }
} as unknown as StrictShardusConfiguration

// Add this before your test cases in secureAccounts.test.ts
jest.mock('../../../../src', () => ({
  shardusConfig: {
    debug: {
      minMultisigRequiredForGlobalTxs: 1
    }
  }
}))

describe('secureAccounts', () => {
  let shardus: Shardus

  beforeEach(() => {
    jest.clearAllMocks()
    shardus = new Shardus(mockShardusConfig)
    ;(WrappedEVMAccountFunctions.updateEthAccountHash as jest.Mock).mockImplementation((arg) => arg)
  })

  describe('isSecureAccount', () => {
    it('should return true for a valid SecureAccount', () => {
      const validAccount = {
        name: 'Test',
        nextTransferAmount: BigInt(0),
        nextTransferTime: 0
      }
      expect(isSecureAccount(validAccount)).toBe(true)
    })

    it('should return false for an invalid object', () => {
      const invalidAccount = {
        foo: 'bar'
      }
      expect(isSecureAccount(invalidAccount)).toBe(false)
    })

    it('should return false for null', () => {
      expect(isSecureAccount(null)).toBe(false)
    })
  })

  describe('validateTransferFromSecureAccount', () => {
    it('should validate a correct transfer transaction', async () => {
      const testPrivateKey = '0x1234567890123456789012345678901234567890123456789012345678901234';
      const testWallet = new ethers.Wallet(testPrivateKey);
      const testAddress = testWallet.address;
      
      // Mock the multisig keys to accept our test wallet
      (shardus.getMultisigPublicKeys as jest.Mock).mockReturnValue({
        [testAddress]: DevSecurityLevel.High
      })

      const txData = {
        amount: '1000000000000000000',
        accountName: 'Foundation',
        nonce: 0
      }

      // Create proper signature
      const payload_hash = ethers.keccak256(ethers.toUtf8Bytes(Utils.safeStringify(txData)))
      const signature = await testWallet.signMessage(payload_hash)

      const validTx = {
        ...txData,
        sign: [{
          owner: testAddress,
          sig: signature
        }],
        isInternalTx: true,
        internalTXType: InternalTXType.TransferFromSecureAccount
      } as InternalTx

      const result = validateTransferFromSecureAccount(validTx, shardus)
      expect(result.reason).toBe('')
      expect(result.success).toBe(true)
    })

    it('should reject invalid transaction type', () => {
      const invalidTx = {
        txType: InternalTXType.ApplyNetworkParam,
        amount: '1000000000000000000',
        accountName: 'Foundation',
        nonce: 0,
        sign: []
      }
      
      const result = validateTransferFromSecureAccount(invalidTx as any, shardus)
      expect(result.success).toBe(false)
      expect(result.reason).toBe('Invalid transaction type')
    })

    it('should reject invalid amount format', () => {
      const invalidTx = {
        txType: InternalTXType.TransferFromSecureAccount,
        amount: 'not-a-number',
        accountName: 'TestAccount',
        nonce: 0,
        sign: []
      }
      
      const result = validateTransferFromSecureAccount(invalidTx as any, shardus)
      expect(result.reason).toBe('Invalid amount format')
      expect(result.success).toBe(false)
    })
  })

  describe('verify', () => {
    it('should verify a valid transfer transaction', async () => {
      const testPrivateKey = '0x1234567890123456789012345678901234567890123456789012345678901234'
      const testWallet = new ethers.Wallet(testPrivateKey)
      const testAddress = testWallet.address
      
      const txData = {
        txType: InternalTXType.TransferFromSecureAccount,
        amount: '1000000000000000000',
        accountName: 'Foundation',
        nonce: 0
      }
      
      const payload_hash = ethers.keccak256(ethers.toUtf8Bytes(Utils.safeStringify(txData)))
      const signature = await testWallet.signMessage(payload_hash)

      const validTx = {
        ...txData,
        sign: [{
          owner: testAddress,
          sig: signature
        }],
        isInternalTx: true,
        internalTXType: InternalTXType.TransferFromSecureAccount,
        timestamp: Date.now()
      } as InternalTx

      ;(shardus.getMultisigPublicKeys as jest.Mock).mockReturnValue({
        [testAddress]: 2
      })

      const wrappedStates = {
        '1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C000000000000000000000000': {
          accountId: '1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C000000000000000000000000',
          stateId: '1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C000000000000000000000000',
          timestamp: Date.now(),
          accountType: AccountType.SecureAccount,
          data: {
            hash: '',
            timestamp: Date.now(),
            accountType: AccountType.SecureAccount,
            nonce: 0,
            name: 'Foundation',
            nextTransferAmount: BigInt('1000000000000000000'),
            nextTransferTime: 0
          }
        },
        '0x1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C': {
          accountId: '0x1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
          stateId: '0x1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
          timestamp: Date.now(),
          accountType: AccountType.Account,
          data: {
            ethAddress: '0x1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
            hash: '',
            timestamp: Date.now(),
            account: { balance: BigInt('2000000000000000000') }
          }
        },
        '0x2f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C': {
          accountId: '0x2f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
          stateId: '0x2f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
          timestamp: Date.now(),
          accountType: AccountType.Account,
          data: {
            ethAddress: '0x2f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
            hash: '',
            timestamp: Date.now(),
            accountType: AccountType.Account,
            account: { balance: BigInt('0') }
          }
        }
      } as WrappedStates

      const result = verify(validTx, wrappedStates, shardus)
      expect(result.reason).toBe('Valid transaction')
      expect(result.success).toBe(true)
    })
  })

  describe('apply', () => {
    it('should apply a valid transfer transaction', async () => {
      const tx = {
        amount: '1000000000000000000',
        accountName: 'Foundation',
        nonce: 0,
        isInternalTx: true,
        internalTXType: InternalTXType.TransferFromSecureAccount,
        timestamp: Date.now()
      } as InternalTx

      const wrappedStates: WrappedStates = {
        '0x1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C': {
          accountId: '0x1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
          stateId: '0x1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C', 
          timestamp: Date.now(),
          data: {
            timestamp: Date.now(),
            ethAddress: '0x1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
            hash: '',
            accountType: AccountType.Account,
            account: {
              nonce: 0,
              balance: BigInt('55880000000000000000000000')
            }
          }
        },
        '0x2f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C': {
          accountId: '0x2f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
          stateId: '0x2f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
          timestamp: Date.now(),
          data: {
            timestamp: Date.now(),
            ethAddress: '0x2f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C',
            hash: '',
            accountType: AccountType.Account,
            account: {
              nonce: 0,
              balance: BigInt('0')
            }
          }
        },
        '1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C000000000000000000000000': {
          accountId: '1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C000000000000000000000000',
          stateId: '1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C000000000000000000000000',
          timestamp: Date.now(),
          data: {
            timestamp: Date.now(),
            ethAddress: '1f1545Eb7EE5C3C1c4784ee9ddE5D26A9f76F77C000000000000000000000000',
            hash: '',
            accountType: AccountType.SecureAccount,
            nonce: 0,
            name: 'Foundation',
            nextTransferAmount: BigInt('1000000000000000000'),
            nextTransferTime: 0
          }
        }
      }

      const applyResponse: ApplyResponse = {
        txTimestamp: Date.now(),
        accountWrites: [],
        appReceiptData: [],
        stateTableResults: [],
        txId: 'txId',
        accountData: [],
        appDefinedData: {},
        failed: false,
        failMessage: '',
        appReceiptDataHash: ''
      } ;
      try {
        await apply(tx, 'txId', Date.now(), wrappedStates, shardus, applyResponse);
      } catch (error) {
        console.error('Full error:', error);
        console.error('Stack trace:', error.stack);
        throw error;
      }
      await expect(apply(tx, 'txId', Date.now(), wrappedStates, shardus, applyResponse))
        .resolves.not.toThrow()
    })
  })
})