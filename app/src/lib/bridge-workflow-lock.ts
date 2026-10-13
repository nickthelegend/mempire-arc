import type {Address} from 'viem';
import {withOriginTransactionLock} from '../chain/origin-transaction-lock';
export const bridgeWorkflowIdentity=(chainId:number,owner:Address)=>`mempire:bridge-workflow:${chainId}:${owner.toLowerCase()}`;
/** Outer Gateway/CCIP lock, distinct from inner source transaction locks (one-way order only). */
export function withBridgeWorkflow<T>(chainId:number,owner:Address,run:()=>Promise<T>):Promise<T>{
 return withOriginTransactionLock(bridgeWorkflowIdentity(chainId,owner),async()=>{
  if(chainId!==5042002)throw Error('Original bridge recovery requires Arc testnet 5042002. No signature or submission was requested.');
  return run();
 });
}
