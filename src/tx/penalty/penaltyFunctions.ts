import { BN } from 'ethereumjs-util'
import { scaleByStabilityFactor, _base16BNParser } from '../../utils'
import { ShardeumFlags } from '../../shardeum/shardeumFlags'
import * as AccountsStorage from '../../storage/accountStorage'
import { NodeAccount2, WrappedEVMAccount } from '../../shardeum/shardeumTypes'
import { logFlags } from '../..'

export function applyPenalty(
  nodeAccount: NodeAccount2,
  operatorEOA: WrappedEVMAccount,
  penalty: bigint
): boolean {
  /* prettier-ignore */ if (logFlags.dapp_verbose) console.log(`\nTracking Penalty on Node: ${nodeAccount.id} of ${penalty.toString()} SHM (not applying)`)

  // convert hex value to BN
  operatorEOA.operatorAccountInfo.stake = _base16BNParser(operatorEOA.operatorAccountInfo.stake)
  operatorEOA.operatorAccountInfo.operatorStats.totalNodePenalty = _base16BNParser(
    operatorEOA.operatorAccountInfo.operatorStats.totalNodePenalty
  )
  nodeAccount.stakeLock = _base16BNParser(nodeAccount.stakeLock)
  nodeAccount.penalty = _base16BNParser(nodeAccount.penalty)
  nodeAccount.nodeAccountStats.totalPenalty = _base16BNParser(nodeAccount.nodeAccountStats.totalPenalty)

  if (penalty > nodeAccount.stakeLock) penalty = nodeAccount.stakeLock

  // Only update penalty tracking stats, don't modify actual stake amounts
  operatorEOA.operatorAccountInfo.operatorStats.totalNodePenalty += penalty
  nodeAccount.penalty += penalty
  nodeAccount.nodeAccountStats.totalPenalty += penalty

  return true
}

export function isLowStake(nodeAccount: NodeAccount2): boolean {
  /**
   * IMPORTANT FUTURE TO-DO =:
   * This function's logic needs to be updated once `stakeRequiredUsd` actually represents
   * USD value rather than SHM.
   */

  const stakeRequiredUSD = AccountsStorage.cachedNetworkAccount.current.stakeRequiredUsd
  const lowStakeThresholdUSD = (stakeRequiredUSD * BigInt(ShardeumFlags.lowStakePercent * 100)) / BigInt(100)
  const lowStakeThreshold = scaleByStabilityFactor(lowStakeThresholdUSD, AccountsStorage.cachedNetworkAccount)

  return nodeAccount.stakeLock < lowStakeThreshold
}
